import { randomInt } from 'node:crypto';
import { splitText } from './telegram-api.js';

// Telegram previews are best-effort. Only committed Session text becomes a
// durable response; streamed LLM deltas may be abandoned or replaced.
const PREVIEW_LIMIT = 3900;
const PREVIEW_INTERVAL_MS = 1100;
const INITIAL_DELAY_MS = 350;

export class StreamingDelivery {
  constructor(api, options = {}) {
    this.api = api;
    this.states = new Map();
    this.warn = options.warn ?? (() => {});
    this.trace = options.trace ?? (() => {});
    this.intervalMs = options.intervalMs ?? PREVIEW_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS;
  }

  stateFor(id, route) {
    let state = this.states.get(id);
    if (!state) {
      state = {
        route, committed: [], attemptId: undefined, attemptText: '',
        draftId: randomInt(1, 2147483647), previewId: undefined,
        lastSent: '', pending: Promise.resolve(), timer: undefined,
        lastSentAt: 0, disabled: false, closed: false,
      };
      this.states.set(id, state);
    }
    return state;
  }

  begin(id, route) {
    // A new turn can begin before the previous turn's Telegram final is sent.
    // finalize() captures the old state, so replacing this entry is safe.
    const previous = this.states.get(id);
    if (previous && !previous.closed) return;
    this.states.set(id, {
      route, committed: [], attemptId: undefined, attemptText: '',
      draftId: randomInt(1, 2147483647), previewId: undefined,
      lastSent: '', pending: Promise.resolve(), timer: undefined,
      lastSentAt: 0, disabled: false, closed: false,
    });
  }

  frame(id, route, frame) {
    if (!frame || !['start', 'chunk', 'end'].includes(frame.type)) return;
    const state = this.stateFor(id, route);
    if (state.closed) return;
    if (frame.type === 'start') {
      state.attemptId = frame.attemptId;
      state.attemptText = '';
      return;
    }
    if (state.attemptId !== frame.attemptId) return;
    if (frame.type === 'end') {
      if (frame.outcome?.kind === 'abandoned') {
        state.attemptText = '';
        this.schedule(state);
      }
      state.attemptId = undefined;
      return;
    }
    if (frame.chunk?.type !== 'text-delta' || typeof frame.chunk.text !== 'string') return;
    state.attemptText += frame.chunk.text;
    this.schedule(state);
  }

  committed(id, route, text) {
    const state = this.stateFor(id, route);
    if (state.closed || !text) return;
    state.committed.push(text);
    state.attemptText = '';
    state.attemptId = undefined;
    this.schedule(state);
  }

  previewText(state) {
    const committed = state.committed.join('\n\n');
    const separator = committed && state.attemptText ? '\n\n' : '';
    return committed + separator + state.attemptText;
  }

  schedule(state) {
    if (state.closed || state.disabled || state.timer !== undefined) return;
    const text = this.previewText(state);
    if (!text.trim() || text === state.lastSent) return;
    const elapsed = Date.now() - state.lastSentAt;
    const interval = state.lastSentAt === 0 ? this.initialDelayMs : this.intervalMs;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.queuePreview(state);
    }, Math.max(0, interval - elapsed));
  }

  queuePreview(state) {
    if (state.closed || state.disabled) return;
    const text = this.previewText(state);
    if (!text.trim() || text === state.lastSent) return;
    const preview = Array.from(text).slice(0, PREVIEW_LIMIT).join('');
    if (preview === state.lastSent) return;
    state.pending = state.pending.then(async () => {
      if (state.closed || state.disabled || preview === state.lastSent) return;
      try {
        if (state.route.chatType === 'private') {
          await this.api.sendDraft(state.route, state.draftId, preview);
        } else if (state.previewId === undefined) {
          const message = await this.api.sendPreview(state.route, preview);
          state.previewId = message.message_id;
        } else {
          await this.api.editPreview(state.route, state.previewId, preview);
        }
        state.lastSent = preview;
        state.lastSentAt = Date.now();
        this.trace('assistant streaming preview updated');
      } catch (error) {
        state.disabled = true;
        this.warn(error);
        this.trace('streaming preview failed; final answer will still be delivered');
      }
    });
    void state.pending.then(() => this.schedule(state));
  }

  detach(id) {
    const state = this.states.get(id);
    if (!state) return undefined;
    state.closed = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    this.states.delete(id);
    return state;
  }

  async finish(state, route, committedText) {
    if (state) await state.pending;
    const text = committedText?.trim() ?? '';
    if (!text) {
      if (!state?.lastSent) return false;
      // Never claim that an uncommitted draft is the model's final answer.
      const notice = 'Ответ был прерван. Отправьте сообщение ещё раз.';
      if (state.route.chatType !== 'private' && state.previewId !== undefined) {
        try {
          await this.api.editPreview(state.route, state.previewId, notice);
          return true;
        } catch (error) { this.warn(error); }
      }
      await this.api.send(route, notice);
      return true;
    }

    if (state?.route.chatType !== 'private' && state?.previewId !== undefined) {
      const chunks = splitText(text, PREVIEW_LIMIT);
      try {
        // Telegram rejects a no-op edit with "message is not modified".
        // A matching preview is already a durable group message.
        if (state.lastSent !== chunks[0]) {
          await this.api.editPreview(route, state.previewId, chunks[0]);
        }
        if (chunks.length > 1) {
          await this.api.send(route, chunks.slice(1).join(''));
        }
        return true;
      } catch (error) {
        this.warn(error);
        // Remove a stale partial if Telegram could not commit it.
        await this.api.deletePreview?.(route, state.previewId).catch(e => this.warn(e));
      }
    }
    // sendMessage replaces the ephemeral sendMessageDraft in a private chat.
    await this.api.send(route, text);
    return true;
  }

  async close() {
    const pending = [];
    for (const state of this.states.values()) {
      state.closed = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
      pending.push(state.pending);
    }
    this.states.clear();
    await Promise.allSettled(pending);
  }

  async drain() {
    await Promise.allSettled([...this.states.values()].map(s => s.pending));
  }
}
