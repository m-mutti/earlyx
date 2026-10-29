import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompiler } from '../src/compiler.js';
import { inspectPdf, longDocumentSource } from '../scripts/stages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const geometry = result => result.layout.pages.map(page => ({ width: page.width, height: page.height, items: page.items }));
const errors = result => result.diagnostics.filter(item => item.severity === 'error');

test('PDF is independently readable and uses shared page dimensions', async () => {
  const compiler = createCompiler({ rootDir: root });
  const result = await compiler.compile(`@title "Independent PDF check"\n\n# Shared layout\n\nA readable document preserves text in PDF and HTML.\n\nKorean: 안녕하세요.\n\nAn equation: $E=mc^2$.\n`, { filename: path.join(root, 'pdf-check.ex'), pdf: true });
  assert.deepEqual(errors(result), []);
  assert.ok(result.pdf.length > 1000);
  assert.match(result.pdf.subarray(0, 5).toString(), /^%PDF-/);
  const inspected = await inspectPdf(result.pdf, result.layout, ['Shared layout', 'readable document', '안녕하세요']);
  assert.equal(inspected.pages, result.stats.pages);
  assert.ok(inspected.pageInfo.every(page => page.textItems > 0));
  assert.ok(result.html.includes('<svg'));
  assert.ok(result.webHtml.includes('Shared layout'));
});

test('a local edit reuses layout while matching a fresh compilation', async () => {
  const compiler = createCompiler({ rootDir: root });
  const source = '# A document\n\nFirst stable paragraph with several words.\n\nSecond stable paragraph with different words.\n\nThird stable paragraph.\n';
  const filename = path.join(root, 'cache-check.ex');
  await compiler.compile(source, { filename, pdf: false });
  const edited = source.replace('different words', 'a deliberate edit that changes wrapping and paragraph height');
  const incremental = await compiler.compile(edited, { filename, pdf: false });
  const fresh = await createCompiler({ rootDir: root }).compile(edited, { filename, pdf: false });
  assert.ok(incremental.stats.cacheHits > 0, 'unchanged blocks should reuse cached layout');
  assert.deepEqual(geometry(incremental), geometry(fresh));
});

test('global style changes invalidate affected layout', async () => {
  const compiler = createCompiler({ rootDir: root });
  const source = '@style(fontSize: 10)\n\n# A heading\n\nA paragraph that has enough words to occupy a line and reveal changes to font metrics.\n';
  const filename = path.join(root, 'style-check.ex');
  const first = await compiler.compile(source, { filename, pdf: false });
  const changed = source.replace('fontSize: 10', 'fontSize: 16');
  const reused = await compiler.compile(changed, { filename, pdf: false });
  const fresh = await createCompiler({ rootDir: root }).compile(changed, { filename, pdf: false });
  assert.notDeepEqual(geometry(first), geometry(reused));
  assert.deepEqual(geometry(reused), geometry(fresh));
});

test('twenty explicit pages stay deterministic after a first-page edit', async () => {
  const source = longDocumentSource();
  const compiler = createCompiler({ rootDir: root });
  const filename = path.join(root, 'twenty-page-check.ex');
  const first = await compiler.compile(source, { filename, pdf: false });
  assert.equal(first.layout.pages.length, 20);
  const edited = source.replace('ORIGINAL', 'A CHANGED VALUE');
  const reused = await compiler.compile(edited, { filename, pdf: false });
  const fresh = await createCompiler({ rootDir: root }).compile(edited, { filename, pdf: false });
  assert.equal(reused.layout.pages.length, 20);
  assert.deepEqual(geometry(reused), geometry(fresh));
});

test('incomplete or invalid input returns source diagnostics and remains usable', async () => {
  const compiler = createCompiler({ rootDir: root });
  const filename = path.join(root, 'invalid-check.ex');
  const broken = await compiler.compile('@style(fontSize: -2)\n\n# Still readable\n\nA valid paragraph.\n', { filename, pdf: false });
  assert.ok(broken.diagnostics.length > 0);
  assert.ok(broken.diagnostics.some(item => item.source?.line || item.line));
  const fixed = await compiler.compile('# Fixed document\n\nA valid paragraph.\n', { filename, pdf: false });
  assert.deepEqual(errors(fixed), []);
  assert.ok(fixed.webHtml.includes('Fixed document'));
});

test('HTML-like source is escaped rather than executed', async () => {
  const result = await createCompiler({ rootDir: root }).compile('# Escaping\n\n<script>alert("source")</script>\n', { filename: path.join(root, 'escape-check.ex'), pdf: false });
  assert.ok(!result.webHtml.includes('<script>alert("source")</script>'));
  assert.ok(result.webHtml.includes('&lt;script&gt;'));
});

test('included content is reread and dependency changes invalidate output', async t => {
  const fixtureRoot = await mkdtemp(path.join(root, '.earlyx-test-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const included = path.join(fixtureRoot, 'chapter.ex');
  await writeFile(included, '# Original chapter\n\nAn original statement.\n');
  const compiler = createCompiler({ rootDir: fixtureRoot });
  const source = '@title "Include test"\n\n@include("chapter.ex")\n';
  const filename = path.join(fixtureRoot, 'main.ex');
  const first = await compiler.compile(source, { filename, pdf: false });
  assert.deepEqual(errors(first), []);
  assert.ok(first.webHtml.includes('Original chapter'));
  await writeFile(included, '# Updated chapter\n\nA changed statement.\n');
  const second = await compiler.compile(source, { filename, pdf: false });
  assert.ok(second.webHtml.includes('Updated chapter'));
  assert.ok(!second.webHtml.includes('Original chapter'));
});

test('include cycles produce a diagnostic instead of unbounded recursion', async t => {
  const fixtureRoot = await mkdtemp(path.join(root, '.earlyx-test-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(path.join(fixtureRoot, 'a.ex'), '@include("b.ex")\n');
  await writeFile(path.join(fixtureRoot, 'b.ex'), '@include("a.ex")\n');
  const result = await createCompiler({ rootDir: fixtureRoot }).compile('@include("a.ex")\n', { filename: path.join(fixtureRoot, 'main.ex'), pdf: false });
  assert.ok(result.diagnostics.some(item => /cycl|recursive|depth/i.test(item.message)));
});

test('showcase keeps references and structured content in both outputs', async () => {
  const filename = path.join(root, 'examples', 'showcase.ex');
  const source = await readFile(filename, 'utf8');
  const result = await createCompiler({ rootDir: root }).compile(source, { filename, pdf: true });
  assert.deepEqual(errors(result), []);
  assert.match(result.webHtml, /<table\b/);
  assert.match(result.webHtml, /<figure\b/);
  assert.match(result.webHtml, /<h[1-6]\b/);
  assert.ok(!result.webHtml.includes('@ref('));
  assert.ok(!result.webHtml.includes('@cite('));
  const inspected = await inspectPdf(result.pdf, result.layout);
  assert.ok(inspected.text.length > 300);
});

test('one hundred explicit pages compile without losing pages or overflowing text', async () => {
  const result = await createCompiler({ rootDir: root }).compile(longDocumentSource(100), { filename: path.join(root, 'hundred-page-check.ex'), pdf: false });
  assert.deepEqual(errors(result), []);
  assert.equal(result.layout.pages.length, 100);
  for (const page of result.layout.pages) {
    const text = page.items.filter(item => item.type === 'text' && item.role !== 'Artifact');
    for (const item of text) {
      assert.ok(item.x >= result.layout.margin - .05, `page ${page.number}: text starts before margin`);
      assert.ok(item.x + item.width <= page.width - result.layout.margin + .05, `page ${page.number}: text extends beyond right margin`);
      assert.ok(item.y + (item.descent || 0) <= page.height - result.layout.margin + .05, `page ${page.number}: body text extends below bottom margin`);
    }
  }
});

test('footnotes reserve space and never overlap flowing body text', async () => {
  const paragraphs = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}. ${'Body text exercises line wrapping and pagination. '.repeat(8)}${index % 3 === 0 ? `[^note${index}]` : ''}`);
  const definitions = Array.from({ length: 20 }, (_, index) => `[^note${index * 3}]: ${'A footnote has its own reserved space. '.repeat(4)}`);
  const source = '# Notes and flowing pages\n\n' + paragraphs.join('\n\n') + '\n\n' + definitions.join('\n') + '\n';
  const result = await createCompiler({ rootDir: root }).compile(source, { filename: path.join(root, 'footnote-stress.ex'), pdf: false });
  assert.deepEqual(errors(result), []);
  assert.ok(result.layout.pages.length > 3);
  let notePages = 0;
  for (const page of result.layout.pages) {
    const notes = page.items.filter(item => item.role === 'Note');
    if (!notes.length) continue;
    notePages++;
    const separator = page.items.find(item => item.type === 'line' && item.width === 90);
    assert.ok(separator, `page ${page.number}: notes have a separator`);
    for (const item of page.items.filter(item => item.type === 'text' && !['Note', 'Artifact'].includes(item.role))) {
      assert.ok(item.y + (item.descent || 0) <= separator.y + .05, `page ${page.number}: body text overlaps footnote separator`);
    }
    for (const note of notes) assert.ok(note.y + (note.descent || 0) <= page.height - result.layout.margin + .05, `page ${page.number}: note extends below margin`);
  }
  assert.ok(notePages > 1);
});

test('long tables paginate within margins and repeat header rows', async () => {
  const source = '# A long table\n\n@table(caption: "Many rows", id: "many-rows")\n| Key | Description |\n| --- | --- |\n' + Array.from({ length: 120 }, (_, index) => `| Row ${index + 1} | ${'A bounded description with ordinary wrapping. '.repeat(3)} |`).join('\n') + '\n';
  const result = await createCompiler({ rootDir: root }).compile(source, { filename: path.join(root, 'table-stress.ex'), pdf: false });
  assert.deepEqual(errors(result), []);
  assert.ok(result.layout.pages.length > 3);
  for (const page of result.layout.pages) {
    const cells = page.items.filter(item => ['TH', 'TD'].includes(item.role));
    if (!cells.length) continue;
    assert.ok(cells.some(item => item.role === 'TH'), `page ${page.number}: continued table needs repeated header`);
    for (const item of cells) assert.ok(item.y + (item.descent || 0) <= page.height - result.layout.margin + .05, `page ${page.number}: table text extends below margin`);
  }
});

test('PDF references have working internal and external link annotations', async () => {
  const result = await createCompiler({ rootDir: root }).compile('# A destination\n@label("destination")\n\nSee @ref("destination") and [the external site](https://example.com/).\n', { filename: path.join(root, 'pdf-links.ex'), pdf: true });
  assert.deepEqual(errors(result), []);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(result.pdf), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const links = (await (await pdf.getPage(1)).getAnnotations()).filter(item => item.subtype === 'Link');
    assert.ok(links.some(item => item.url === 'https://example.com/'));
    const internal = links.find(item => item.dest === 'destination');
    assert.ok(internal, 'cross-reference emits a named-destination annotation');
    assert.ok(await pdf.getDestination('destination'), 'named destination resolves in PDF');
  } finally { await task.destroy(); }
});

test('an oversized table row is split within pages or produces a clear source diagnostic', async () => {
  const source = '# Oversized table\n\n@table(caption: "Tall row")\n| Cell |\n| --- |\n| ' + 'very long content '.repeat(500) + ' |\n';
  const result = await createCompiler({ rootDir: root }).compile(source, { filename: path.join(root, 'oversized-row.ex'), pdf: false });
  const overflow = result.layout.pages.some(page => page.items.some(item => item.role === 'TD' && item.y + (item.descent || 0) > page.height - result.layout.margin + .05));
  assert.ok(!overflow || result.diagnostics.some(item => item.severity === 'error' && /table|row/i.test(item.message)), 'oversized content must not silently extend beyond the page');
});
