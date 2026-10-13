// Safe subset of model Markdown for Telegram's HTML parse mode.
// Never pass unescaped model HTML, raw URLs in tags, or unbalanced tags.
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function inline(text) {
  const pattern = /(\x60[^\x60\n]+\x60)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^\n*]+)\*\*|__([^\n_]+)__|~~([^\n~]+)~~|\*([^\n*]+)\*|(?<![\w])_([^_\n]+)_(?![\w])/g;
  let result = '', pos = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(pos, match.index));
    if (match[1]) result += '<code>' + escapeHtml(match[1].slice(1, -1)) + '</code>';
    else if (match[2]) {
      // Only http(s) destinations are clickable. Reject control characters
      // and parse URL without accepting javascript: or other protocols.
      let valid = false;
      try {
        const url = new URL(match[3]);
        valid = ['http:', 'https:'].includes(url.protocol);
      } catch { /* leave the raw Markdown as safe escaped text */ }
      result += valid
        ? '<a href="' + escapeHtml(match[3]) + '">' + inline(match[2]) + '</a>'
        : escapeHtml(match[0]);
    } else if (match[4] || match[5]) result += '<b>' + inline(match[4] || match[5]) + '</b>';
    else if (match[6]) result += '<s>' + inline(match[6]) + '</s>';
    else result += '<i>' + inline(match[7] || match[8]) + '</i>';
    pos = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(pos));
}

export function markdownToTelegramHtml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let code = null;
  for (const line of lines) {
    const fence = /^[ \t]*\x60{3}([a-zA-Z0-9_-]*)[ \t]*$/.exec(line);
    if (fence) {
      if (code === null) code = [];
      else {
        out.push('<pre>' + escapeHtml(code.join('\n')) + '</pre>');
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) out.push('<b>' + inline(heading[1]) + '</b>');
    else if (/^\s*[-*+]\s+/.test(line)) out.push('• ' + inline(line.replace(/^(\s*)[-*+]\s+/, '$1')));
    else if (/^>\s?/.test(line)) out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
    else out.push(inline(line));
  }
  if (code !== null) out.push('<pre>' + escapeHtml(code.join('\n')) + '</pre>');
  return out.join('\n');
}

export function splitMarkdownText(text, limit = 3400) {
  // Split original text, never HTML: Telegram length limits apply after
  // entity parsing, and each converted chunk contains balanced tags.
  const chunks = [];
  let remaining = Array.from(String(text));
  while (remaining.length) {
    if (remaining.length <= limit) {
      chunks.push(remaining.join(''));
      break;
    }
    const boundary = remaining.slice(0, limit).lastIndexOf('\n');
    const size = boundary >= Math.floor(limit / 3) ? boundary + 1 : limit;
    chunks.push(remaining.slice(0, size).join(''));
    remaining = remaining.slice(size);
  }
  return chunks;
}
