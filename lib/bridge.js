import { isAllowedMessage, removeMention, routeForMessage } from './routing.js';
import { StateStore } from './state.js';
import { TelegramApi } from './telegram-api.js';
import { StreamingDelivery } from './streaming.js';
import { VoiceTranscriber } from './voice.js';
import { VoiceTranscriptStore } from './voice-store.js';
import { TelegramQuestions } from './questions.js';

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
    // The first authorized user owns the private approval inbox.
    this.superAdminId = options.allowedUserIds[0];
    this.allowedGroupChatIds = new Set(options.allowedGroupChatIds);
    this.requireMention = options.requireMention;
    this.diagnostics = options.diagnostics === true;
    this.diagnosticSink = options.diagnosticSink ?? console.error;
    this.workspaceId = options.workspaceId;
    this.makeUserMessage = options.makeUserMessage;
    this.store = options.store ?? new StateStore(options.stateFile);
    this.api = options.api ?? new TelegramApi(options.token);
    this.voice = options.voice ?? (options.stt?.url
      ? new VoiceTranscriber({ api: this.api, ...options.stt }) : null);
    this.voiceStore = options.voiceStore ?? (options.stt?.url
      ? new VoiceTranscriptStore({ password: options.dbPassword, host: options.dbHost }) : null);
    this.questions = new TelegramQuestions({
      api: this.api,
      routeForSession: id => {
        const route = this.routesBySession.get(id);
        return route && this.store.get(route.key)?.sessionId === id ? route : undefined;
      },
      permitted: (state, userId) => this.allowedUserIds.has(userId)
        && (state.route.chatType === 'private' || this.isGroupAuthorized(state.route.chatId))
        && this.store.get(state.route.key)?.sessionId === state.sessionId,
      trace: event => this.trace(event), warn: error => this.warn(error),
    });
    this.abort = new AbortController();
    this.routesBySession = new Map();
    this.turnTexts = new Map();
    this.sendQueues = new Map();
    this.streaming = new StreamingDelivery(this.api, {
      warn: error => this.warn(error), trace: event => this.trace(event),
    });
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
      this.routesBySession.set(binding.sessionId, {
        ...binding, key,
        // Existing state files store only chatId and threadId. Recover the
        // destination type without migrating or discarding conversations.
        chatType: binding.chatId > 0 ? 'private' : 'supergroup',
      });
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
    await this.refreshPendingApprovalCards();
    // The Web UI's Remote forwarding listener is registered earlier and
    // holds the waterfall open while waiting for a browser answer. Prepend
    // this handler so Telegram-bound Sessions can answer natively; requests
    // for unrelated Sessions delegate to that existing Web listener.
    this.unsubscribeQuestions = this.ctx.on('user-questions/request',
      (request, next) => {
        this.trace('interactive question waterfall reached');
        return this.questions.ask(request, next);
      },
      { global: true, prepend: true });
    this.unsubscribe = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event), { global: true });
    this.unsubscribeStream = this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const id = agent?.session?.id;
      const route = this.routesBySession.get(id);
      if (route) this.streaming.frame(id, route, frame);
    }, { global: true });
    await this.api.setCommands(this.abort.signal).catch(err => this.warn(err));
    this.pollTask = this.pollLoop();
    this.trace('polling loop scheduled');
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.unsubscribe?.();
    this.unsubscribeStream?.();
    this.unsubscribeQuestions?.();
    this.questions.close();
    await this.pollTask?.catch(() => {});
    await this.streaming.close();
    await this.voiceStore?.close();
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
    if (update.callback_query) {
      if (await this.questions.callback(update.callback_query)) return;
      await this.handleApprovalCallback(update.callback_query);
      return;
    }
    if (update.my_chat_member) {
      await this.handleMembershipUpdate(update.my_chat_member);
      return;
    }
    const message = update.message;
    const route = routeForMessage(message);
    if (!route) {
      this.trace('update ignored: no supported message');
      return;
    }
    if (route.chatType !== 'private' && !this.isGroupAuthorized(route.chatId)) {
      await this.requestGroupApproval(message.chat);
      this.trace('message ignored: group approval required');
      return;
    }
    if (!this.allowedUserIds.has(message?.from?.id)) {
      this.trace('message ignored: sender not authorized');
      return;
    }
    if (!isAllowedMessage(message, {
      allowedUserIds: this.allowedUserIds,
      allowedGroupChatIds: this.effectiveAllowedGroups(),
      // An explicit superadmin approval authorizes natural conversation in
      // this group: no @mention/reply required for an allowed sender.
      // Keep the legacy requireMention policy for statically allowlisted groups.
      requireMention: this.store.groupApproval(route.chatId)?.status === 'allowed'
        ? false : this.requireMention,
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
    // A text reply to a pending question is a tool answer, not a new turn.
    if (text && await this.questions.message(message, route)) return;
    if (message.voice || message.audio) {
      if (!this.voice || !this.voiceStore) {
        await this.api.send(route, 'Распознавание голосовых пока не подключено.', this.abort.signal);
        return;
      }
      // Group voice uses the same allowlist + approved-group access checks
      // performed above, before downloading or sending audio to STT.
      try {
        await this.handleVoice(message, route);
      } catch (error) {
        this.warn(error);
        await this.api.send(route,
          'Не удалось обработать голосовое. Проверьте STT-сервис и отправьте запись ещё раз.',
          this.abort.signal);
      }
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

  async handleVoice(message, route) {
    if (!Number.isSafeInteger(message.message_id)) {
      throw new Error('Invalid Telegram message id');
    }
    // Get a usable Harness session BEFORE downloading any audio.
    let agent, sessionId;
    const binding = this.store.get(route.key);
    if (binding) {
      sessionId = binding.sessionId;
      agent = await this.resolveAgent(sessionId);
    } else {
      agent = await this.createBinding(route);
      sessionId = this.store.get(route.key).sessionId;
    }

    let record = await this.voiceStore.find(route, message.message_id);
    if (record?.submitted_at) {
      this.trace('duplicate voice ignored');
      return;
    }
    if (!record) {
      this.trace('downloading and transcribing voice');
      const result = await this.voice.transcribe(message, this.abort.signal);
      record = await this.voiceStore.save(route, message, sessionId, result);
    }
    if (!record?.formatted_text?.trim()) throw new Error('Empty archived transcript');

    const caption = typeof message.caption === 'string' && message.caption.trim()
      ? '\n\n' + message.caption.trim() : '';
    agent.followup(this.makeUserMessage(record.formatted_text + caption));
    await this.voiceStore.markSubmitted(route, message.message_id);
    this.trace('voice transcript submitted to Harness');
  }

  async refreshPendingApprovalCards() {
    for (const [id, row] of this.store.groupApprovals()) {
      if (row.status !== 'pending' || row.notificationMessageId === undefined
        || row.formatVersion === 2) continue;
      try {
        await this.api.refreshGroupApprovalCard(this.superAdminId, row.notificationMessageId,
          { id: Number(id), title: row.title }, row, this.abort.signal);
        await this.store.markGroupFormatted(Number(id), row.token);
        this.trace('existing group approval card formatting upgraded');
      } catch (error) {
        // Formatting is cosmetic: never prevent polling or an admin decision.
        this.warn(error);
        this.trace('could not refresh existing approval card');
      }
    }
  }

  effectiveAllowedGroups() {
    const groups = new Set(this.allowedGroupChatIds);
    for (const [id, row] of this.store.groupApprovals()) {
      if (row.status === 'allowed') groups.add(Number(id));
    }
    return groups;
  }

  isGroupAuthorized(chatId) {
    return this.allowedGroupChatIds.has(chatId)
      || this.store.groupApproval(chatId)?.status === 'allowed';
  }

  async requestGroupApproval(chat, options = {}) {
    if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
    if (this.isGroupAuthorized(chat.id)) return;
    const { approval, created } = await this.store.requestGroup(chat, options);
    if (approval.status !== 'pending') {
      this.trace('group request skipped: access previously denied');
      return;
    }
    if (approval.notificationMessageId !== undefined) return;
    try {
      const response = await this.api.requestGroupApproval(
        this.superAdminId, { id: chat.id, title: approval.title }, approval, this.abort.signal);
      await this.store.markGroupNotified(chat.id, approval.token, response.message_id);
      this.trace(created ? 'group access request sent to superadmin'
        : 'group access request resent to superadmin');
    } catch (error) {
      // Group updates must not poison the polling queue if the admin has not
      // started a private chat with this bot yet. Retry on a later update.
      this.warn(error);
      this.trace('cannot notify superadmin yet; group remains blocked');
    }
  }

  async handleMembershipUpdate(event) {
    const chat = event?.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
    if (event?.new_chat_member?.user?.id !== this.botId) return;
    const joined = new Set(['member', 'administrator']);
    const wasMember = joined.has(event?.old_chat_member?.status);
    const isMember = joined.has(event?.new_chat_member?.status);
    if (!wasMember && isMember) {
      this.trace('added to group; checking approval');
      await this.requestGroupApproval(chat, { rejoined: true });
    }
  }

  async handleApprovalCallback(callback) {
    const match = typeof callback?.data === 'string'
      ? /^group:(allow|deny):([a-f0-9]{16})$/.exec(callback.data) : null;
    if (!match) return;
    if (callback.from?.id !== this.superAdminId
      || callback.message?.chat?.id !== this.superAdminId
      || callback.message?.chat?.type !== 'private') {
      this.trace('group decision refused: non-superadmin');
      await this.api.answerCallbackQuery(callback.id, 'Доступ запрещён', this.abort.signal);
      return;
    }
    const [, action, token] = match;
    const matchRow = this.store.groupApprovals().find(([, row]) => row.token === token);
    if (!matchRow || (matchRow[1].notificationMessageId !== undefined
      && callback.message.message_id !== matchRow[1].notificationMessageId)) {
      await this.api.answerCallbackQuery(callback.id, 'Заявка устарела', this.abort.signal);
      return;
    }
    const decision = await this.store.decideGroup(token, action === 'allow' ? 'allowed' : 'denied');
    if (decision.result !== 'applied') {
      await this.api.answerCallbackQuery(callback.id, 'Решение уже принято', this.abort.signal);
      return;
    }
    this.trace(action === 'allow' ? 'superadmin approved group' : 'superadmin denied group');
    // The durable decision is committed before acknowledging the button.
    await this.api.answerCallbackQuery(callback.id,
      action === 'allow' ? 'Группа разрешена' : 'Группа отклонена', this.abort.signal)
      .catch(error => this.warn(error));
    await this.api.editApprovalCard(this.superAdminId, callback.message.message_id,
      { id: decision.chatId, title: decision.approval.title },
      action === 'allow', this.abort.signal).catch(error => this.warn(error));
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
    if (previous?.sessionId !== undefined && previous.sessionId !== created.sessionId) {
      this.questions.cancelForRoute(route.key);
    }
    this.trace('session binding persisted');
    // Keep the prior session routed until any in-flight turn settles.
    // Otherwise /new can silently swallow a reply still being generated.
    this.routesBySession.set(created.sessionId, {
      chatId: route.chatId, chatType: route.chatType, threadId: route.threadId,
      sessionId: created.sessionId, key: route.key,
    });
    return agent;
  }

  onSessionEvent(session, event) {
    const route = this.routesBySession.get(session.id);
    if (!route) return;
    if (event.type === 'turn/start') {
      this.trace('Harness turn started');
      this.turnTexts.set(session.id, []);
      this.streaming.begin(session.id, route);
      return;
    }
    if (event.type === 'assistant/message') {
      this.trace('Harness assistant message received');
      const text = assistantText(event);
      if (!text) return;
      const fragments = this.turnTexts.get(session.id) ?? [];
      fragments.push(text);
      this.turnTexts.set(session.id, fragments);
      this.streaming.committed(session.id, route, text);
      return;
    }
    if (event.type === 'turn/end') {
      this.trace('Harness turn finished');
      const text = (this.turnTexts.get(session.id) ?? []).join('\n\n').trim();
      this.turnTexts.delete(session.id);
      // Capture the ending turn before another queued prompt can begin.
      const settled = this.streaming.detach(session.id);
      this.enqueue(route.key, async () => {
        const delivered = await this.streaming.finish(settled, route, text);
        if (delivered) this.trace('assistant response delivered to Telegram');
        else this.trace('no committed assistant text to deliver');
        // A /new switch may have happened while this earlier turn was running.
        if (this.store.get(route.key)?.sessionId !== session.id) {
          this.routesBySession.delete(session.id);
        }
      });
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
    await this.streaming.drain();
    await Promise.allSettled([...this.sendQueues.values()]);
  }
}
