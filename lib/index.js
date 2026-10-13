import path from 'node:path';
import os from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import { TelegramBridge } from './bridge.js';
import { parseIds } from './routing.js';

export const name = 'dsh-telegram-bridge';
export const inject = ['agents', 'sessionController', 'workspaceRegistry'];
export const Config = Schema.object({
  token: Schema.string().default(''),
  allowedUserIds: Schema.array(Schema.number()).default([]),
  allowedGroupChatIds: Schema.array(Schema.number()).default([]),
  workspaceId: Schema.string().default(''),
  requireMention: Schema.boolean().default(true),
  stateFile: Schema.string().default(''),
});

function diagnosticsFromEnv() {
  const value = process.env.DSH_TELEGRAM_DIAGNOSTICS;
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('DSH_TELEGRAM_DIAGNOSTICS must be 0 or 1');
}

function requireMentionFromEnv() {
  const value = process.env.DSH_TELEGRAM_REQUIRE_MENTION;
  if (value === undefined || value === '') return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('DSH_TELEGRAM_REQUIRE_MENTION must be true or false');
}

export function apply(ctx, config) {
  const token = (config.token || process.env.DSH_TELEGRAM_TOKEN || '').trim();
  const allowedUserIds = config.allowedUserIds?.length
    ? config.allowedUserIds : parseIds(process.env.DSH_TELEGRAM_ALLOWED_USER_IDS);
  if (!token) {
    ctx.logger.info('dsh-telegram-bridge disabled: no bot token configured');
    return;
  }
  if (!allowedUserIds.length) {
    ctx.logger.warn('dsh-telegram-bridge disabled: no allowed user IDs configured');
    return;
  }
  const allowedGroupChatIds = config.allowedGroupChatIds?.length
    ? config.allowedGroupChatIds : parseIds(process.env.DSH_TELEGRAM_ALLOWED_GROUP_CHAT_IDS);
  const stateFile = config.stateFile ||
    process.env.DSH_TELEGRAM_STATE_FILE ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'telegram-bridge-state.json');
  const bridge = new TelegramBridge(ctx, {
    token, allowedUserIds, allowedGroupChatIds,
    workspaceId: config.workspaceId || process.env.DSH_TELEGRAM_WORKSPACE_ID || '',
    requireMention: config.requireMention === false ? false : requireMentionFromEnv(),
    diagnostics: diagnosticsFromEnv(),
    stateFile,
    makeUserMessage: text => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  });
  ctx.effect(() => {
    void bridge.start().catch(error => ctx.logger.error('dsh-telegram-bridge startup failed: ' + String(error?.message ?? error)));
    return () => { void bridge.stop(); };
  }, 'dsh-telegram-bridge.polling');
}
