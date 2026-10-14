/** Optional PostgreSQL archive. Uses the preexisting assistant_agent role. */
export class VoiceTranscriptStore {
  constructor({ password, host = 'postgres', database = 'assistant', user = 'assistant_agent', pool }) {
    if (!password && !pool) throw new Error('Voice archive database password is required');
    this.connection = { host, database, user, password };
    this.pool = pool ?? null;
    this.ownsPool = !pool;
  }

  async getPool() {
    if (!this.pool) {
      const { default: pg } = await import('pg');
      this.pool = new pg.Pool({
        ...this.connection, max: 2, connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      });
    }
    return this.pool;
  }

  async find(route, messageId) {
    const pool = await this.getPool();
    const { rows } = await pool.query(
      'SELECT formatted_text, submitted_at FROM personal.voice_transcripts ' +
      'WHERE telegram_chat_id = $1 AND telegram_message_id = $2',
      [route.chatId, messageId],
    );
    return rows[0] ?? null;
  }

  async save(route, message, sessionId, result) {
    const pool = await this.getPool();
    const { rows } = await pool.query(
      'INSERT INTO personal.voice_transcripts ' +
      '(telegram_chat_id, telegram_thread_id, telegram_message_id, telegram_user_id, session_id, ' +
      'raw_text, formatted_text, segments, engine, model, duration_seconds) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) ' +
      'ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING RETURNING id',
      [route.chatId, route.threadId, message.message_id, message.from.id, sessionId,
        result.raw_text, result.formatted_text, JSON.stringify(result.segments),
        result.engine ?? null, result.model ?? null, result.duration_seconds ?? null],
    );
    if (rows.length) return { formatted_text: result.formatted_text, submitted_at: null };
    // A duplicate may follow a crash after STT: reuse the persisted transcript.
    return await this.find(route, message.message_id);
  }

  async markSubmitted(route, messageId) {
    const pool = await this.getPool();
    await pool.query(
      'UPDATE personal.voice_transcripts SET submitted_at = now() ' +
      'WHERE telegram_chat_id = $1 AND telegram_message_id = $2 AND submitted_at IS NULL',
      [route.chatId, messageId],
    );
  }

  async close() {
    if (this.ownsPool && this.pool) await this.pool.end();
  }
}
