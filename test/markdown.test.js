import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml, stripMd, escapeHtml } from '../public/markdown.js';

test('escapes HTML — no injection from agent/user text', () => {
  const html = mdToHtml('<img src=x onerror=alert(1)> **bold**');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<strong>bold</strong>'));
});

test('links: only safe hrefs; javascript: is neutralised', () => {
  const html = mdToHtml('[ok](https://x.io) [bad](javascript:alert(1))');
  assert.ok(html.includes('href="https://x.io"'));
  assert.ok(html.includes('href="#"'));
  assert.ok(!html.toLowerCase().includes('javascript:'));
});

test('file-path links become file-links carrying the path in data-file', () => {
  const rel = mdToHtml('see [Bar.tsx:42](app/components/Bar.tsx:42)');
  assert.ok(rel.includes('class="file-link"'), 'relative path -> file-link');
  assert.ok(rel.includes('data-file="app/components/Bar.tsx:42"'), 'path preserved in data-file');
  assert.ok(rel.includes('href="#"'), 'href stays inert');

  const abs = mdToHtml('[cfg](/Users/x/proj/config.js)');
  assert.ok(abs.includes('data-file="/Users/x/proj/config.js"'), 'absolute path preserved');

  // still NOT a file link: real schemes and anchors
  assert.ok(!mdToHtml('[a](https://x.io)').includes('file-link'), 'http is not a file link');
  assert.ok(!mdToHtml('[a](javascript:alert(1))').includes('file-link'), 'js scheme is not a file link');
});

test('inline + fenced code', () => {
  assert.ok(mdToHtml('use `foo` here').includes('<code>foo</code>'));
  const fenced = mdToHtml('```js\nconst a = 1;\n```');
  assert.ok(fenced.includes('<pre><code>const a = 1;</code></pre>'));
});

test('backslash escapes render literally (regression)', () => {
  // \* must NOT become italic
  const a = mdToHtml('a \\*not italic\\* b');
  assert.ok(!a.includes('<em>'), a);
  assert.ok(a.includes('&#42;not italic&#42;'), a); // asterisks escaped to entities -> render literally
  // escaped backtick inside inline code renders as a literal backtick
  const b = mdToHtml('`a\\`b`');
  assert.ok(b.includes('<code>'));
  assert.ok(b.includes('&#96;'), b); // literal backtick entity inside the code span
  assert.ok(!/<code>a<\/code>/.test(b));
});

test('GFM pipe tables (regression)', () => {
  const html = mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>a</th>'));
  assert.ok(html.includes('<td>1</td>') && html.includes('<td>4</td>'));
  // a lone --- (no pipes) is a horizontal rule, not a table
  assert.ok(mdToHtml('---').includes('<hr>'));
});

test('lists, headings, blockquote', () => {
  assert.ok(mdToHtml('- one\n- two').includes('<ul>\n<li>one</li>\n<li>two</li>\n</ul>'));
  assert.ok(mdToHtml('### Title').includes('<h5>Title</h5>'));
  assert.ok(mdToHtml('> quoted').includes('<blockquote>quoted</blockquote>'));
});

test('stripMd yields a clean one-line preview', () => {
  assert.equal(stripMd('**Bold** `code`\n\n- item'), 'Bold code item');
});

test('escapeHtml handles nullish', () => {
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('a<b'), 'a&lt;b');
});
