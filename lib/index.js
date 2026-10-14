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
  const diagnostics = diagnosticsFromEnv();
  if (diagnostics) console.error('telegram bridge diagnostic: plugin apply invoked');
  const token = (config.token || process.env.DSH_TELEGRAM_TOKEN || '').trim();
  const allowedUserIds = config.allowedUserIds?.length
    ? config.allowedUserIds : parseIds(process.env.DSH_TELEGRAM_ALLOWED_USER_IDS);
  if (!token) {
    if (diagnostics) console.error('telegram bridge diagnostic: disabled (missing token)');
    ctx.logger.info('dsh-telegram-bridge disabled: no bot token configured');
    return;
  }
  if (!allowedUserIds.length) {
    if (diagnostics) console.error('telegram bridge diagnostic: disabled (no authorized users)');
    ctx.logger.warn('dsh-telegram-bridge disabled: no allowed user IDs configured');
    return;
  }
  const allowedGroupChatIds = config.allowedGroupChatIds?.length
    ? config.allowedGroupChatIds : parseIds(process.env.DSH_TELEGRAM_ALLOWED_GROUP_CHAT_IDS);
  const stateFile = config.stateFile ||
    process.env.DSH_TELEGRAM_STATE_FILE ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'telegram-bridge-state.json');
  const sttUrl = process.env.DSH_TELEGRAM_STT_URL || '';
  const sttToken = process.env.DSH_TELEGRAM_STT_TOKEN || '';
  if (sttUrl && !sttToken) throw new Error('STT is enabled but DSH_TELEGRAM_STT_TOKEN is missing');
  const bridge = new TelegramBridge(ctx, {
    stt: sttUrl ? { url: sttUrl, token: sttToken } : null,
    dbPassword: process.env.DSH_DA_PERSONAL_DB_PASSWORD,
    dbHost: process.env.DSH_TELEGRAM_PG_HOST || 'postgres',
    token, allowedUserIds, allowedGroupChatIds,
    workspaceId: config.workspaceId || process.env.DSH_TELEGRAM_WORKSPACE_ID || '',
    requireMention: config.requireMention === false ? false : requireMentionFromEnv(),
    diagnostics,
    stateFile,
    makeUserMessage: text => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  });
  if (diagnostics) console.error('telegram bridge diagnostic: registering startup effect');
  ctx.effect(() => {
    if (diagnostics) console.error('telegram bridge diagnostic: startup effect invoked');
    void bridge.start().catch(error => {
      ctx.logger.error('dsh-telegram-bridge startup failed: ' + String(error?.message ?? error));
      if (diagnostics) {
        // Details may include personal data, so write only the failure category.
        console.error('telegram bridge diagnostic: startup failed (' +
          (error?.name || 'unknown error') + ')');
      }
    });
    return () => {
      if (diagnostics) console.error('telegram bridge diagnostic: startup effect disposed');
      void bridge.stop();
    };
  }, 'dsh-telegram-bridge.polling');
}
