import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Stored per DSH instance. No access to the agent's personal data is needed.
export class StateStore {
  constructor(filename) {
    this.filename = filename;
    this.state = { version: 1, nextOffset: 0, bindings: {}, groupApprovals: {} };
  }
  async load() {
    let text;
    try { text = await readFile(this.filename, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    const state = JSON.parse(text);
    if (state.version !== 1 || !Number.isSafeInteger(state.nextOffset)
      || !state.bindings || typeof state.bindings !== 'object' || Array.isArray(state.bindings)) {
      throw new Error('Unsupported or damaged Telegram state: back up the file before editing it');
    }
    for (const [key, value] of Object.entries(state.bindings)) {
      if (!/^-?\d+:\d+$/.test(key) || typeof value?.sessionId !== 'string'
        || !value.sessionId || !Number.isSafeInteger(value.chatId)
        || !Number.isSafeInteger(value.threadId)) {
        throw new Error('Invalid Telegram topic binding in state file');
      }
    }
    const approvals = state.groupApprovals ?? {};
    if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) {
      throw new Error('Invalid Telegram group approvals');
    }
    for (const [id, row] of Object.entries(approvals)) {
      if (!/^-\d+$/.test(id) || !Number.isSafeInteger(Number(id))
        || !['pending', 'allowed', 'denied'].includes(row?.status)
        || typeof row.token !== 'string' || !/^[a-f0-9]{16}$/.test(row.token)
        || typeof row.title !== 'string'
        || (row.notificationMessageId !== undefined && !Number.isSafeInteger(row.notificationMessageId))
        || (row.formatVersion !== undefined && row.formatVersion !== 2)) {
        throw new Error('Invalid Telegram group approval row');
      }
    }
    this.state = { ...state, groupApprovals: approvals };
  }
  groupApproval(chatId) { return this.state.groupApprovals[String(chatId)]; }
  groupApprovals() { return Object.entries(this.state.groupApprovals); }
  async requestGroup(chat, { rejoined = false } = {}) {
    if (!Number.isSafeInteger(chat?.id) || !['group','supergroup'].includes(chat.type)) {
      throw new Error('Group approval requires a Telegram group chat');
    }
    const key = String(chat.id);
    const current = this.state.groupApprovals[key];
    if (current && !(rejoined && current.status === 'denied')) {
      return { created: false, approval: current };
    }
    const approval = {
      status: 'pending',
      token: randomUUID().replaceAll('-', '').slice(0, 16),
      title: typeof chat.title === 'string' && chat.title.trim()
        ? chat.title.trim().slice(0, 120) : 'Unnamed group',
    };
    this.state.groupApprovals[key] = approval;
    await this.flush();
    return { created: true, approval };
  }
  async markGroupNotified(chatId, token, messageId) {
    const row = this.groupApproval(chatId);
    if (row?.status !== 'pending' || row.token !== token) return;
    if (!Number.isSafeInteger(messageId)) throw new Error('Invalid admin notification message ID');
    row.notificationMessageId = messageId;
    row.formatVersion = 2;
    await this.flush();
  }
  async markGroupFormatted(chatId, token) {
    const row = this.groupApproval(chatId);
    if (row?.status !== 'pending' || row.token !== token) return;
    row.formatVersion = 2;
    await this.flush();
  }
  async decideGroup(token, status) {
    if (!['allowed','denied'].includes(status)) throw new Error('Invalid group approval decision');
    const match = this.groupApprovals().find(([, row]) => row.token === token);
    if (!match) return { result: 'missing' };
    const [chatId, row] = match;
    if (row.status !== 'pending') return { result: 'already-decided', chatId: Number(chatId), approval: row };
    row.status = status;
    await this.flush();
    return { result: 'applied', chatId: Number(chatId), approval: row };
  }
  get(key) { return this.state.bindings[key]; }
  entries() { return Object.entries(this.state.bindings); }
  seen(id) { return id < this.state.nextOffset; }
  offset() { return this.state.nextOffset || undefined; }
  async bind(route, sessionId) {
    this.state.bindings[route.key] = { chatId: route.chatId, threadId: route.threadId, sessionId };
    await this.flush();
  }
  async checkpoint(id) {
    if (id + 1 <= this.state.nextOffset) return;
    this.state.nextOffset = id + 1;
    await this.flush();
  }
  async flush() {
    await mkdir(dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, this.filename);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
