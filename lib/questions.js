import { randomBytes } from 'node:crypto';

// Translate the native ask_user_question waterfall into one Telegram question
// at a time. Never forward a button click as a fresh agent followup: the
// original tool Promise must settle with the structured answer batch.
export class TelegramQuestions {
  constructor({ api, routeForSession, permitted, trace = () => {}, warn = () => {} }) {
    this.api = api;
    this.routeForSession = routeForSession;
    this.permitted = permitted;
    this.trace = trace;
    this.warn = warn;
    this.pending = new Map();
  }

  async ask(request, next) {
    const sessionId = request?.agent?.session?.id;
    const route = sessionId && this.routeForSession(sessionId);
    if (!route || !Array.isArray(request.questions) || request.questions.length === 0) {
      return next();
    }
    const questions = request.questions;
    if (questions.some(q => typeof q.id !== 'string' || typeof q.question !== 'string'
      || (q.options !== undefined && (!Array.isArray(q.options)
        || q.options.length > 80 || q.options.some(o => typeof o?.label !== 'string'))))) {
      return next();
    }
    this.trace('interactive question routed to Telegram');
    const answers = [];
    for (const [index, question] of questions.entries()) {
      let answer;
      try {
        answer = await this.askOne({ route, sessionId, question,
          signal: request.signal, index, total: questions.length });
      } catch (error) {
        // The first prompt could not be displayed: leave the native Web UI
        // available rather than holding an invisible wait.
        if (index === 0 && error?.code === 'QUESTION_SEND_FAILED'
          && !request.signal?.aborted) return next();
        throw error;
      }
      answers.push(answer);
    }
    return { answers };
  }

  async askOne({ route, sessionId, question, signal, index, total }) {
    if (signal?.aborted) throw new Error('Question was aborted');
    const token = randomBytes(9).toString('hex');
    const state = {
      token, route, sessionId, question, index, total,
      selected: new Set(), awaitingCustom: false, done: false,
      messageId: undefined, resolve: undefined, reject: undefined,
      cleanup: undefined,
    };
    const choice = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    // Install a rejection handler immediately, even if Telegram send fails.
    void choice.catch(() => {});
    this.pending.set(token, state);
    const abort = () => this.cancel(state);
    state.cleanup = () => {
      this.pending.delete(token);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) this.cancel(state);
    try {
      if (!state.done) {
        const text = this.renderText(state);
        if (text.length > 3900) {
          // Display long supporting detail without losing it to truncation.
          await this.api.send(route, text, signal);
        }
        const shown = text.length > 3900
          ? '❓ Вопрос ' + (index + 1) + '/' + total + '\n' + question.question.slice(0, 1600)
          : text;
        const result = await this.api.sendQuestion(route, shown,
          this.keyboard(state), signal);
        state.messageId = result.message_id;
      }
    } catch (error) {
      if (!state.done) {
        state.done = true;
        state.cleanup();
        const unavailable = new Error('Cannot display question in Telegram');
        unavailable.code = 'QUESTION_SEND_FAILED';
        state.reject(unavailable);
      }
    }
    return choice;
  }

  renderText(state) {
    const { question: q, index, total } = state;
    const parts = ['❓ Вопрос ' + (index + 1) + '/' + total];
    if (q.header) parts.push(String(q.header));
    parts.push(q.question);
    if (q.detail) parts.push(String(q.detail));
    if (q.options?.length) {
      parts.push(q.options.map((option, i) =>
        (i + 1) + '. ' + option.label
        + (option.description ? '\n' + option.description : '')).join('\n\n'));
    }
    if (q.multiSelect) parts.push('Можно выбрать несколько вариантов и нажать «Готово».');
    return parts.join('\n\n');
  }

  keyboard(state) {
    const { token, question: q } = state;
    const rows = (q.options ?? []).map((option, i) => [{
      text: (state.selected.has(i) ? '✅ ' : '') +
        String(option.label).slice(0, 55),
      callback_data: 'q:' + token + ':' + i.toString(36),
    }]);
    if (q.multiSelect) rows.push([{ text: '✅ Готово',
      callback_data: 'q:' + token + ':ok' }]);
    rows.push([{ text: '✍️ Свой ответ', callback_data: 'q:' + token + ':custom' }]);
    rows.push([{ text: '⏭ Пропустить', callback_data: 'q:' + token + ':skip' }]);
    return { inline_keyboard: rows };
  }

  async callback(callback) {
    const match = /^q:([a-f0-9]{18}):(ok|custom|skip|[0-9a-z]+)$/.exec(callback?.data ?? '');
    if (!match) return false;
    const state = this.pending.get(match[1]);
    if (!state || state.done) {
      await this.ack(callback.id, 'Вопрос уже закрыт');
      return true;
    }
    if (!this.authorized(state, callback.from?.id, callback.message?.chat?.id,
      callback.message?.message_id)) {
      await this.ack(callback.id, 'Нет доступа к этому вопросу');
      return true;
    }
    const kind = match[2];
    const options = state.question.options ?? [];
    if (kind === 'skip') {
      await this.ack(callback.id, 'Пропущено');
      await this.complete(state, { id: state.question.id, selected: [] });
    } else if (kind === 'custom') {
      state.awaitingCustom = true;
      await this.ack(callback.id, 'Отправьте ответ текстом в этот топик');
      // A subsequent ordinary message in this route is captured as the custom
      // answer only after the user explicitly selected this action.
    } else if (kind === 'ok' && state.question.multiSelect) {
      await this.ack(callback.id, 'Выбрано');
      await this.complete(state, { id: state.question.id,
        selected: [...state.selected].sort((a, b) => a - b).map(i => options[i].label) });
    } else {
      const i = Number.parseInt(kind, 36);
      if (!/^[0-9a-z]+$/.test(kind) || !Number.isSafeInteger(i)
        || i < 0 || i >= options.length || kind !== i.toString(36)) {
        await this.ack(callback.id, 'Такого варианта нет');
      } else if (state.question.multiSelect) {
        if (state.selected.has(i)) state.selected.delete(i);
        else state.selected.add(i);
        await this.ack(callback.id, 'Выбор обновлён');
        await this.api.editQuestionMarkup(state.route, state.messageId,
          this.keyboard(state)).catch(this.warn);
      } else {
        await this.ack(callback.id, 'Выбрано');
        await this.complete(state, { id: state.question.id, selected: [options[i].label] });
      }
    }
    return true;
  }

  // Intercept only an explicit reply to the question or text after "Own answer".
  // Other chat messages remain ordinary Harness followups.
  async message(message, route) {
    const text = message?.text?.trim();
    if (!text) return false;
    const waiting = [...this.pending.values()].reverse().find(state =>
      !state.done && state.route.key === route.key &&
      this.permitted(state, message.from?.id) &&
      (state.awaitingCustom || state.messageId === message.reply_to_message?.message_id));
    if (!waiting) return false;
    await this.complete(waiting, { id: waiting.question.id,
      selected: waiting.question.multiSelect
        ? [...waiting.selected].sort((a, b) => a - b).map(i => waiting.question.options[i].label)
        : [],
      custom: text });
    return true;
  }

  authorized(state, userId, chatId, messageId) {
    return chatId === state.route.chatId && messageId === state.messageId
      && this.permitted(state, userId);
  }

  async ack(id, message) {
    try { await this.api.answerCallbackQuery(id, message); }
    catch (error) { this.warn(error); }
  }

  async complete(state, answer) {
    if (state.done) return;
    state.done = true;
    state.cleanup();
    state.resolve(answer);
    this.trace('Telegram answer returned to active Harness question');
    const summary = answer.custom || answer.selected.join(', ') || 'Пропущено';
    try {
      await this.api.closeQuestion(state.route, state.messageId,
        '✅ ' + state.question.question.slice(0, 250) + '\n\n' + summary.slice(0, 2800));
    } catch (error) { this.warn(error); }
  }

  cancel(state) {
    if (state.done) return;
    state.done = true;
    state.cleanup();
    const error = new Error('ask_user_question was aborted before the user answered');
    error.code = 'ASK_ABORTED';
    state.reject(error);
    if (state.messageId !== undefined) {
      void this.api.closeQuestion(state.route, state.messageId,
        '⌛ Вопрос больше не активен').catch(this.warn);
    }
  }

  cancelForRoute(key) {
    for (const state of [...this.pending.values()]) {
      if (state.route.key === key) this.cancel(state);
    }
  }

  close() {
    for (const state of [...this.pending.values()]) this.cancel(state);
  }
}
