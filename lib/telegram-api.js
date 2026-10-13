/** Minimal Bot API adapter. Never rewrite or translate the agent's text. */
/** Escape group-supplied titles before interpolating them into Telegram HTML. */
export function escapeTelegramHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[char]);
}

export class TelegramApi {
  constructor(token, options = {}) {
    this.token = token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.pollTimeout = options.pollTimeout ?? 25;
  }
  async call(method, data, signal) {
    const timeout = AbortSignal.timeout((method === 'getUpdates' ? this.pollTimeout * 1000 : 0) + 20000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let payload, status;
    try {
      const response = await this.fetch(this.baseUrl + '/bot' + this.token + '/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data), signal: combined,
      });
      status = response.status;
      payload = await response.json();
    } catch (err) {
      throw new Error('Telegram ' + method + ' request failed: ' +
        String(err?.message ?? err).replaceAll(this.token, '[REDACTED]'));
    }
    if (!payload?.ok) {
      const reason = String(payload?.description ?? 'HTTP ' + status).replaceAll(this.token, '[REDACTED]');
      const error = new Error('Telegram ' + method + ': ' + reason);
      error.retryAfter = payload?.parameters?.retry_after;
      error.code = payload?.error_code ?? status;
      throw error;
    }
    return payload.result;
  }
  getMe(signal) { return this.call('getMe', {}, signal); }
  getUpdates(offset, signal) {
    return this.call('getUpdates', { offset, timeout: this.pollTimeout, allowed_updates: ['message', 'my_chat_member', 'callback_query'] }, signal);
  }
  setCommands(signal) {
    return this.call('setMyCommands', { commands: [
      { command: 'start', description: 'Welcome' },
      { command: 'help', description: 'Help and commands' },
      { command: 'new', description: 'New conversation in this topic' },
      { command: 'status', description: 'Current topic connection' },
    ] }, signal);
  }
  groupApprovalPayload(adminUserId, group, approval) {
    return {
      chat_id: adminUserId,
      parse_mode: 'HTML',
      text: '🛡️ <b>Запрос на подключение группы</b>\n\n'
        + '<b>Группа:</b> ' + escapeTelegramHtml(group.title)
        + '\n<b>ID:</b> <code>' + escapeTelegramHtml(group.id) + '</code>'
        + '\n\nРазрешить боту работать в этой группе?',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Разрешить', callback_data: 'group:allow:' + approval.token },
        { text: '❌ Отклонить', callback_data: 'group:deny:' + approval.token },
      ]] },
    };
  }
  requestGroupApproval(adminUserId, group, approval, signal) {
    return this.call('sendMessage', this.groupApprovalPayload(adminUserId, group, approval), signal);
  }
  refreshGroupApprovalCard(adminUserId, messageId, group, approval, signal) {
    return this.call('editMessageText', {
      ...this.groupApprovalPayload(adminUserId, group, approval),
      message_id: messageId,
    }, signal);
  }
  answerCallbackQuery(callbackQueryId, text, signal) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text }, signal);
  }
  editApprovalCard(adminUserId, messageId, group, allowed, signal) {
    return this.call('editMessageText', {
      chat_id: adminUserId,
      message_id: messageId,
      parse_mode: 'HTML',
      text: (allowed ? '✅ <b>Доступ разрешён</b>' : '❌ <b>Доступ отклонён</b>')
        + '\n\n<b>Группа:</b> ' + escapeTelegramHtml(group.title)
        + '\n<b>ID:</b> <code>' + escapeTelegramHtml(group.id) + '</code>',
    }, signal);
  }
  async send(route, text, signal) {
    for (const chunk of splitText(text, 3900)) {
      const body = { chat_id: route.chatId, text: chunk };
      // General topics are addressed without a thread ID.
      if (route.threadId > 1) body.message_thread_id = route.threadId;
      await this.call('sendMessage', body, signal);
    }
  }
}
export function splitText(text, limit = 3900) {
  if (!text || typeof text !== 'string') return [];
  const chars = Array.from(text);
  const result = [];
  for (let i = 0; i < chars.length; i += limit) result.push(chars.slice(i, i + limit).join(''));
  return result;
}
