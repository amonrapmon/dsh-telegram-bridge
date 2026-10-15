import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

// Integration guard against the real Cordis waterfall ordering. The Web
// gateway registers its forwarding answerer first and waits for browser input.
// The Telegram answerer is installed later when its polling plugin starts.
test('late Telegram listener with prepend claims ask_user_question before waiting Web', async () => {
  const ctx = new Context();
  let webWasCalled = false;
  let telegramWasCalled = false;
  try {
    ctx.on('user-questions/request', async () => {
      webWasCalled = true;
      // A real Web answerer stays here until a browser submits a selection.
      return new Promise(() => {});
    }, { global: true });
    ctx.on('user-questions/request', async () => {
      telegramWasCalled = true;
      return { answers: [{ id: 'time', selected: ['16:00'] }] };
    }, { global: true, prepend: true });
    const result = await ctx.waterfall('user-questions/request',
      { questions: [{ id: 'time', question: 'Во сколько?' }] },
      () => { throw new Error('should be handled by Telegram'); });
    assert.deepEqual(result, { answers: [{ id: 'time', selected: ['16:00'] }] });
    assert.equal(telegramWasCalled, true);
    assert.equal(webWasCalled, false);
  } finally {
    await ctx.fiber.dispose();
  }
});
