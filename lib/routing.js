/**
 * Address a conversation by Telegram chat + topic, never by chat alone.
 * Topic 0 is a regular chat/root; topic 1 is the forum General topic.
 */
export function routeForMessage(message) {
  const chat = message?.chat;
  if (!chat || !Number.isSafeInteger(chat.id)) return null;
  if (!['private', 'group', 'supergroup'].includes(chat.type)) return null;
  const raw = message.message_thread_id;
  const threadId = Number.isSafeInteger(raw) && raw > 0
    ? raw : chat.is_forum === true ? 1 : 0;
  return { chatId: chat.id, chatType: chat.type, threadId, key: String(chat.id) + ':' + threadId };
}
export function parseIds(raw) {
  if (!raw) return [];
  const parts = String(raw).split(/[\s,;]+/).filter(Boolean);
  if (!parts.every(x => /^-?[1-9]\d*$/.test(x) && Number.isSafeInteger(Number(x)))) {
    throw new Error('Telegram allowlists must contain numeric IDs separated by commas');
  }
  return [...new Set(parts.map(Number))];
}
const escapeRegex = text => text.replace(/[\^$.*+?()[\]{}|]/g, '\\$&');
export function isAllowedMessage(message, options) {
  const route = routeForMessage(message);
  if (!route) return false;
  const userId = message.from?.id;
  if (!Number.isSafeInteger(userId) || !options.allowedUserIds.has(userId)) return false;
  if (route.chatType === 'private') return true;
  if (!options.allowedGroupChatIds.has(route.chatId)) return false;
  if (options.requireMention === false) return true;
  const content = message.text ?? message.caption ?? '';
  if (options.botUsername &&
    new RegExp('@' + escapeRegex(options.botUsername) + '(?![A-Za-z0-9_])', 'i').test(content)) return true;
  return Boolean(options.botId && message.reply_to_message?.from?.id === options.botId);
}
export function removeMention(text, username) {
  if (!username) return text;
  return text.replace(new RegExp('@' + escapeRegex(username) + '(?![A-Za-z0-9_])', 'gi'), '').trim();
}
