import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTranscriber } from '../lib/voice.js';
import { TelegramApi } from '../lib/telegram-api.js';

const result = {
  raw_text: 'проверить календарь', formatted_text: 'Проверить календарь.',
  segments: [{ start: 0, end: 2, text: 'проверить календарь' }],
  engine: 'gigaam', model: 'gigaam-v3-e2e-ctc', duration_seconds: 2,
};

test('voice uses downloaded bytes, not bot-specific file_id, and Bearer token', async () => {
  let fileId, request;
  const api = {
    async downloadFile(id, options) {
      fileId = id;
      assert.equal(options.maxBytes, 20 * 1024 * 1024);
      return Buffer.from('ogg voice');
    },
  };
  const voice = new VoiceTranscriber({
    api, url: 'http://stt:8080/v1/transcribe', token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json(result);
    },
  });
  const data = await voice.transcribe({
    voice: { file_id: 'VOICE_FILE_ID', file_size: 123 },
  });
  assert.equal(fileId, 'VOICE_FILE_ID');
  assert.equal(request.url, 'http://stt:8080/v1/transcribe');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.equal((await request.options.body.get('file').arrayBuffer()).byteLength, 9);
  assert.deepEqual(data, result);
});

test('rejects too-large file before download or model call', async () => {
  let called = false;
  const voice = new VoiceTranscriber({
    api: { async downloadFile() { called = true; } },
    url: 'http://stt:8080/v1/transcribe', token: 'secret',
  });
  await assert.rejects(voice.transcribe({
    audio: { file_id: 'larger', file_size: 21 * 1024 * 1024 },
  }), /too large/);
  assert.equal(called, false);
});

test('STT transport errors do not include private token or URL', async () => {
  const voice = new VoiceTranscriber({
    api: { async downloadFile() { return Buffer.from('bytes'); } },
    url: 'http://stt:8080/v1/transcribe', token: 'very-private-secret',
    fetchImpl: async () => { throw new Error('very-private-secret leaked'); },
  });
  await assert.rejects(voice.transcribe({ voice: { file_id: 'f' } }),
    error => error.message === 'STT transport unavailable');
});

test('Telegram getFile downloads bounded binary only', async () => {
  const seen = [];
  const api = new TelegramApi('TEST_TOKEN', {
    fetch: async url => {
      seen.push(url);
      if (url.endsWith('/getFile')) {
        return { status: 200, json: async () => ({
          ok: true, result: { file_path: 'voice/file_12.oga', file_size: 6 },
        }) };
      }
      return new Response(Buffer.from('abcdef'));
    },
  });
  const bytes = await api.downloadFile('file-id', { maxBytes: 6 });
  assert.equal(bytes.toString(), 'abcdef');
  assert.equal(seen.length, 2);
  assert.ok(seen[1].includes('/file/botTEST_TOKEN/voice/file_12.oga'));
});

test('Telegram rejects oversized streamed download', async () => {
  const api = new TelegramApi('TOKEN', {
    fetch: async url => url.endsWith('/getFile')
      ? { status: 200, json: async () => ({
        ok: true, result: { file_path: 'voice/file_1.oga' },
      }) }
      : new Response(Buffer.from('way too much')),
  });
  await assert.rejects(api.downloadFile('f', { maxBytes: 4 }), /size limit/);
});
