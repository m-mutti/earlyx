import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler } from '../src/compiler.js';

test('custom page sizes and declared font/alignment/accent reach both output modes', async () => {
  const result = await createCompiler().compile('@page(width: 400, height: 500, margin: 30)\n@style(font: "sans", align: "right", accent: "#aa3322")\n\nA [linked sentence](https://example.com) with **bold** text.\n', { pdf: false });
  assert.equal(result.layout.width, 400);
  assert.equal(result.layout.height, 500);
  assert.equal(result.diagnostics.length, 0);
  const text = result.layout.pages[0].items.filter(i => i.type === 'text' && i.role !== 'Artifact');
  assert.ok(text.some(i => i.font === 'sansBold'));
  assert.ok(text.some(i => i.link && i.color === '#aa3322'));
  assert.ok(text[0].x > 30);
  assert.match(result.webHtml, /Earlyx Sans/);
  assert.match(result.webHtml, /text-align:right/);
  assert.match(result.webHtml, /data:application\/octet-stream;base64/);
});

test('nested ordered lists preserve their starting number and structure', async () => {
  const result = await createCompiler().compile('3. First\n  1. Nested\n4. Second\n', { pdf: false });
  assert.match(result.webHtml, /<ol[^>]*start="3"/);
  assert.match(result.webHtml, /<li[^>]*>First<ol><li/);
  const listLabels = result.layout.pages[0].items.filter(i => i.role === 'Lbl').map(i => i.text).join('');
  assert.equal(listLabels, '3.1.4.');
});

test('reference names cannot collide with JavaScript object prototypes', async () => {
  const result = await createCompiler().compile('# A section\n@label("constructor")\n\nSee @ref("constructor").\n\n# Another section\n@label("__proto__")\n\nSee @ref("__proto__").', { pdf: false });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.webHtml, /Section 1/);
  assert.match(result.webHtml, /Section 2/);
});

test('an already canceled compilation returns no stale export', async () => {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(flag, 0, 1);
  await assert.rejects(createCompiler().compile('# Canceled', { cancelFlag: flag }), { name: 'AbortError' });
});
