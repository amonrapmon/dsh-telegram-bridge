/** Voice transport: download only authorized Telegram media and call existing STT API. */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class VoiceTranscriber {
  constructor({ api, url, token, fetchImpl = globalThis.fetch,
    maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!/^https?:\/\//.test(url ?? '') || !token) {
      throw new Error('Voice STT requires a URL and Bearer token');
    }
    this.api = api;
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
  }

  async transcribe(message, signal) {
    const media = message.voice || message.audio;
    if (!media?.file_id) throw new Error('Missing Telegram audio');
    if (media.file_size > this.maxBytes) throw new Error('Audio too large');
    const filename = message.voice ? 'voice.ogg' : 'audio.bin';
    // Telegram getFile and binary download are called only AFTER Bridge ACL.
    const buffer = await this.api.downloadFile(media.file_id, {
      maxBytes: this.maxBytes, signal,
    });
    const data = new FormData();
    data.append('file', new Blob([buffer], {
      type: message.voice ? 'audio/ogg' : media.mime_type || 'application/octet-stream',
    }), filename);
    let response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + this.token },
        body: data,
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch {
      throw new Error('STT transport unavailable');
    }
    if (!response.ok) throw new Error('STT HTTP ' + response.status);
    let json;
    try { json = await response.json(); }
    catch { throw new Error('STT returned invalid JSON'); }
    if (!json || typeof json.raw_text !== 'string'
      || typeof json.formatted_text !== 'string'
      || !Array.isArray(json.segments)) {
      throw new Error('STT returned invalid transcript');
    }
    if (!json.formatted_text.trim()) throw new Error('STT returned empty transcript');
    return json;
  }
}
