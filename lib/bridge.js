import { isAllowedMessage, removeMention, routeForMessage } from './routing.js';
import { StateStore } from './state.js';
import { TelegramApi } from './telegram-api.js';

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

function assistantText(event) {
  if (event.type !== 'assistant/message') return '';
  if (event.surfaceOp && event.surfaceOp !== 'append') return '';
  const content = event.data?.message?.content;
  return Array.isArray(content)
    ? content.filter(p => p.type === 'text').map(p => p.text).join('').trim()
    : '';
}

export class TelegramBridge {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.allowedUserIds = new Set(options.allowedUserIds);
    this.allowedGroupChatIds = new Set(options.allowedGroupChatIds);
    this.requireMention = options.requireMention;
    this.diagnostics = options.diagnostics === true;
    this.diagnosticSink = options.diagnosticSink ?? console.error;
    this.workspaceId = options.workspaceId;
    this.makeUserMessage = options.makeUserMessage;
    this.store = options.store ?? new StateStore(options.stateFile);
    this.api = options.api ?? new TelegramApi(options.token);
    this.abort = new AbortController();
    this.routesBySession = new Map();
    this.turnTexts = new Map();
    this.sendQueues = new Map();
    this.stopped = false;
    this.botId = undefined;
    this.botUsername = undefined;
    this.pollTask = undefined;
  }

  async initialize() {
    this.trace('loading persisted routing state');
    await this.store.load();
    this.trace('routing state loaded');
    for (const [key, binding] of this.store.entries()) {
      this.routesBySession.set(binding.sessionId, { ...binding, key });
    }
  }

  trace(action) {
    if (this.diagnostics) {
      // Write to the process stderr: the Cordis logger may be hidden in Web mode.
      // Every action is a hard-coded, metadata-only event without user or bot IDs.
      this.diagnosticSink('telegram bridge diagnostic: ' + action);
    }
  }

  async start() {
    this.trace('starting bridge');
    await this.initialize();
    this.trace('connecting to Telegram');
    const me = await this.api.getMe(this.abort.signal);
    this.botId = me.id;
    this.botUsername = me.username;
    this.trace('connected to Telegram; starting polling');
    this.unsubscribe = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    await this.api.setCommands(this.abort.signal).catch(err => this.warn(err));
    this.pollTask = this.pollLoop();
    this.trace('polling loop scheduled');
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.unsubscribe?.();
    await this.pollTask?.catch(() => {});
    await Promise.allSettled([...this.sendQueues.values()]);
  }

  warn(err) {
    this.ctx.logger.warn('telegram bridge: ' + String(err?.message ?? err));
    if (this.diagnostics) {
      // No arbitrary error text is written to stderr: it may contain identifiers.
      const code = Number.isInteger(err?.code) ? err.code : null;
      this.trace(code === null ? 'error (no Telegram API status)' :
        'Telegram API error HTTP ' + code);
    }
  }

  async pollLoop() {
    let failures = 0;
    while (!this.stopped) {
      let updates;
      try {
        updates = await this.api.getUpdates(this.store.offset(), this.abort.signal);
        this.trace('poll cycle completed: ' + (updates?.length ?? 0) + ' updates');
        failures = 0;
      } catch (err) {
        if (this.stopped) break;
        this.warn(err);
        this.trace('polling request failed; retrying');
        const ms = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        await sleep(ms, this.abort.signal);
        continue;
      }
      for (const update of updates ?? []) {
        if (this.stopped) return;
        if (!Number.isSafeInteger(update.update_id) || this.store.seen(update.update_id)) continue;
        try {
          await this.handleUpdate(update);
          await this.store.checkpoint(update.update_id);
          this.trace('update handled and checkpointed');
        } catch (err) {
          this.warn(err);
          this.trace('update handler failed; retrying without checkpoint');
          // Do not acknowledge failed admission. Retry after a short pause.
          await sleep(1000, this.abort.signal);
          break;
        }
      }
    }
  }

  async handleUpdate(update) {
    const message = update.message;
    const route = routeForMessage(message);
    if (!route) {
      this.trace('update ignored: no supported message');
      return;
    }
    if (!this.allowedUserIds.has(message?.from?.id)) {
      this.trace('message ignored: sender not authorized');
      return;
    }
    if (route.chatType !== 'private' && !this.allowedGroupChatIds.has(route.chatId)) {
      this.trace('message ignored: group not authorized');
      return;
    }
    if (!isAllowedMessage(message, {
      allowedUserIds: this.allowedUserIds,
      allowedGroupChatIds: this.allowedGroupChatIds,
      requireMention: this.requireMention,
      botId: this.botId,
      botUsername: this.botUsername,
    })) {
      this.trace('message ignored: group mention or reply required');
      return;
    }
    this.trace('message accepted: ' + route.chatType +
      (route.threadId > 0 ? ' with topic' : ' without topic'));

    let text = message.text?.trim() ?? '';
    const command = text.match(/^\/(start|help|status|new)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase();
    if (command === 'start' || command === 'help') {
      this.trace('handling help/start command');
      await this.api.send(route, 'Send a message to talk to Harness. Each Telegram topic keeps its own conversation.\nCommands: /new (new conversation), /status (current connection), /help.', this.abort.signal);
      return;
    }
    if (command === 'status') {
      this.trace('handling status command');
      const binding = this.store.get(route.key);
      await this.api.send(route, binding ? 'This topic is connected to a Harness conversation.' :
        'No conversation in this topic yet. Send a message to begin.', this.abort.signal);
      return;
    }
    if (command === 'new') {
      this.trace('handling new command');
      try {
        await this.createBinding(route);
      } catch (err) {
        this.warn(err);
        this.trace('new conversation could not be created');
        // A workspace or model configuration error must not poison Telegram's
        // update queue. Acknowledge this command after notifying the user.
        await this.api.send(route,
          'Could not create a Harness conversation. Check your workspace and model settings in Harness Web UI, then try /new again.',
          this.abort.signal);
        return;
      }
      await this.api.send(route, 'Started a new conversation in this topic.', this.abort.signal);
      return;
    }
    if (message.voice || message.audio) {
      await this.api.send(route, 'Voice transcription is not configured. Please send text.', this.abort.signal);
      return;
    }
    if (!text) {
      if (message.photo || message.document) {
        await this.api.send(route, 'Files and images are not available in this early preview.', this.abort.signal);
      }
      return;
    }
    text = route.chatType === 'private' ? text : removeMention(text, this.botUsername);
    if (!text) return;

    this.trace('submitting user text to Harness');
    let agent;
    try {
      const binding = this.store.get(route.key);
      agent = binding ? await this.resolveAgent(binding.sessionId)
        : await this.createBinding(route);
    } catch (err) {
      this.warn(err);
      await this.api.send(route, 'Cannot open this conversation. Check the Harness workspace, or send /new to start another.', this.abort.signal);
      return;
    }
    agent.followup(this.makeUserMessage(text));
    this.trace('user text handed to Harness');
  }

  sessionLocation() {
    const workspaces = this.ctx.workspaceRegistry.list();
    if (this.workspaceId) {
      const workspace = workspaces.find(w => w.id === this.workspaceId);
      if (!workspace) throw new Error('Configured workspace was not found in Harness');
      return { workspaceId: workspace.id };
    }
    if (workspaces.length === 1) return { workspaceId: workspaces[0].id };
    if (workspaces.length === 0) {
      // SessionController.create accepts cwd when no registered Workspace exists.
      // Use the assistant process working directory, not an invented Workspace.
      this.trace('no registered workspace; using default working directory');
      return { cwd: process.cwd() };
    }
    throw new Error('Multiple workspaces: set DSH_TELEGRAM_WORKSPACE_ID');
  }

  async resolveAgent(sessionId) {
    const resolution = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in resolution) throw resolution.error;
    return resolution.agent;
  }

  async createBinding(route) {
    const created = await this.ctx.sessionController.create(this.sessionLocation());
    const agent = await this.resolveAgent(created.sessionId);
    const previous = this.store.get(route.key);
    await this.store.bind(route, created.sessionId);
    this.trace('session binding persisted');
    if (previous) this.routesBySession.delete(previous.sessionId);
    this.routesBySession.set(created.sessionId, {
      chatId: route.chatId, threadId: route.threadId, sessionId: created.sessionId, key: route.key,
    });
    return agent;
  }

  onSessionEvent(session, event) {
    const route = this.routesBySession.get(session.id);
    if (!route) return;
    if (event.type === 'turn/start') {
      this.trace('Harness turn started');
      this.turnTexts.set(session.id, []);
      return;
    }
    if (event.type === 'assistant/message') {
      this.trace('Harness assistant message received');
      const text = assistantText(event);
      if (!text) return;
      const fragments = this.turnTexts.get(session.id) ?? [];
      fragments.push(text);
      this.turnTexts.set(session.id, fragments);
      return;
    }
    if (event.type === 'turn/end') {
      this.trace('Harness turn finished');
      const text = (this.turnTexts.get(session.id) ?? []).join('\n\n').trim();
      this.turnTexts.delete(session.id);
      if (text) this.enqueue(route.key, async () => {
        await this.api.send(route, text, this.abort.signal);
        this.trace('assistant response delivered to Telegram');
      });
      else this.trace('no committed assistant text to deliver');
    }
  }

  enqueue(key, action) {
    const previous = this.sendQueues.get(key) ?? Promise.resolve();
    const task = previous.then(action).catch(err => this.warn(err));
    this.sendQueues.set(key, task);
    void task.finally(() => {
      if (this.sendQueues.get(key) === task) this.sendQueues.delete(key);
    });
    return task;
  }

  async drain() {
    await Promise.allSettled([...this.sendQueues.values()]);
  }
}
