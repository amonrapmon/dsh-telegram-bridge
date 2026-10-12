import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Stored per DSH instance. No access to the agent's personal data is needed.
export class StateStore {
  constructor(filename) {
    this.filename = filename;
    this.state = { version: 1, nextOffset: 0, bindings: {} };
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
    this.state = state;
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
