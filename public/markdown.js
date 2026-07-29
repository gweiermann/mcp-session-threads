// Minimal, dependency-free, XSS-safe Markdown -> HTML.
// Escapes HTML first, then transforms, so rendered agent/user text can never
// inject markup. Supports: headings, bold/italic, inline + fenced code,
// ordered/unordered lists, blockquotes, horizontal rules, links (safe href
// only), GFM pipe tables, and backslash escapes (e.g. `a\`b`, \*not italic\*).
//
// Shared by the browser UI and the Node test suite (pure string functions).

const SENT = ''; // private-use sentinel for code placeholders (never in real text)

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function inline(t) {
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      return `<a href="${url.replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    }
    if (/^#/.test(url)) return `<a href="${url.replace(/"/g, '%22')}">${txt}</a>`;
    // thread:<id> -> a stable in-board link to another thread ("duplicate of R6"),
    // rendered as a real hash href so middle-click opens it in a new tab too.
    const th = url.match(/^thread:([\w-]+)$/i);
    if (th) return `<a href="#/t/${th[1]}" class="thread-link" title="Open thread ${th[1]}">${txt}</a>`;
    // A full editor deep link the agent wrote directly, e.g.
    // vscode://file/Users/…/foo.ts:42 — treat it as a file link on its absolute
    // path so the UI opens it (rather than neutralising the vscode: scheme).
    const vs = url.match(/^vscode:\/\/file(\/.+)$/i);
    if (vs) return `<a href="#" class="file-link" title="Open in VS Code" data-file="${vs[1].replace(/"/g, '&quot;')}">${txt}</a>`;
    // Any other URL scheme (javascript:, data:, tel:, …) is neutralised. A
    // "scheme" has no "/" or "." before its ":", which keeps file paths like
    // "src/foo.ts:42" out of this branch. Render WITHOUT href so a click is inert
    // (an href="#" would jump to the dashboard).
    if (/^[a-z][a-z0-9+-]*:/i.test(url)) return `<a class="dead-link" title="blocked link">${txt}</a>`;
    // Otherwise it's a file path (relative or absolute, optionally :line[:col]).
    // The UI turns clicks on these into "open in editor" — the path lives in
    // data-file (escaped) so it is never an executable href.
    return `<a href="#" class="file-link" title="Open in VS Code" data-file="${url.replace(/"/g, '&quot;')}">${txt}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  return t;
}

const splitRow = (r) => {
  let s = r.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
};
const isTableSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l);

export function mdToHtml(src) {
  if (!src) return '';
  let s = escapeHtml(src);
  // backslash escapes -> numeric entities so the literal char renders and is
  // never re-parsed as markdown / code / table pipe.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, (m, ch) => '&#' + ch.charCodeAt(0) + ';');

  const blocks = [];
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `${SENT}B${blocks.length - 1}${SENT}`;
  });
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, code) => {
    codes.push(code);
    return `${SENT}C${codes.length - 1}${SENT}`;
  });

  const lines = s.split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push('</' + list + '>');
      list = null;
    }
  };
  const codeBlockRe = new RegExp('^' + SENT + 'B(\\d+)' + SENT + '\\s*$');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let mm;
    if (/\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      closeList();
      const header = line;
      i++; // consume separator
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') rows.push(lines[++i]);
      const th = splitRow(header).map((c) => `<th>${inline(c)}</th>`).join('');
      const body = rows.map((r) => `<tr>${splitRow(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
    } else if ((mm = line.match(codeBlockRe))) {
      flushPara();
      closeList();
      out.push(`<pre><code>${blocks[+mm[1]]}</code></pre>`);
    } else if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
    } else if ((mm = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      closeList();
      const lvl = Math.min(mm[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(mm[2])}</h${lvl}>`);
    } else if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push('<li>' + inline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>');
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push('<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
    } else if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      closeList();
      out.push('<blockquote>' + inline(line.replace(/^\s*&gt;\s?/, '')) + '</blockquote>');
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
    } else {
      para.push(line);
    }
  }
  flushPara();
  closeList();

  let html = out.join('\n');
  html = html.replace(new RegExp(SENT + 'C(\\d+)' + SENT, 'g'), (m, i) => `<code>${codes[+i]}</code>`);
  return html;
}

/** Collapse markdown to a clean one-line string (for previews/titles). */
export function stripMd(s) {
  return String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '') // list markers
    .replace(/^\s{0,3}>\s?/gm, '') // blockquote markers
    .replace(/[`*_#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
