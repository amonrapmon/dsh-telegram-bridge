import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, markdownToTelegramHtml, splitMarkdownText } from '../lib/format.js';

test('Google-style model answer renders bold headings, lists, and links',()=>{
  const input = '# Модели Google\n**Gemini 3.1 Pro** — февраль ([подробнее](https://cloud.google.com/blog?id=1&lang=ru))\n- **Gemini 4** — октябрь\n- \x60gemini-3\x60';
  const html = markdownToTelegramHtml(input);
  assert.match(html, /^<b>Модели Google<\/b>/);
  assert.match(html, /<b>Gemini 3\.1 Pro<\/b>/);
  assert.match(html, /<a href="https:\/\/cloud\.google\.com\/blog\?id=1&amp;lang=ru">подробнее<\/a>/);
  assert.match(html, /• <b>Gemini 4<\/b>/);
  assert.match(html, /<code>gemini-3<\/code>/);
  assert.doesNotMatch(html, /\*\*Gemini/);
});
test('user and model HTML is escaped, unsafe Markdown URL stays inert',()=>{
  const input='Look <script>alert(1)</script> & "quote" [click](javascript:alert(1))';
  const html=markdownToTelegramHtml(input);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&amp; &quot;quote&quot;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<a href="javascript:'));
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
});
test('balanced pre code blocks, italic, and strike work',()=>{
  const input='*курсив* и ~~зачёркнуто~~\n\x60\x60\x60js\nconst a = 1 < 2;\n\x60\x60\x60';
  const html=markdownToTelegramHtml(input);
  assert.match(html, /<i>курсив<\/i>/);
  assert.match(html, /<s>зачёркнуто<\/s>/);
  assert.match(html, /<pre>const a = 1 &lt; 2;<\/pre>/);
});
test('long answers split before formatting and retain the entire Unicode text',()=>{
  const input='🐱'.repeat(4500);
  const chunks=splitMarkdownText(input);
  assert.ok(chunks.length>1);
  assert.ok(chunks.every(x=>Array.from(x).length<=3400));
  assert.equal(chunks.join(''),input);
});
