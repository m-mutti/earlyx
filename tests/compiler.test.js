import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompiler } from '../src/compiler.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-compiler-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, compiler: createCompiler({ rootDir: root }) };
}

test('includes remain project-local after resolving symbolic links', async t => {
  const { directory, root, compiler } = await fixture(t);
  await fs.writeFile(path.join(directory, 'secret.ex'), '# Private sibling content');
  await fs.symlink(path.join(directory, 'secret.ex'), path.join(root, 'linked.ex'));
  const result = await compiler.compile('@include("../secret.ex")\n@include("linked.ex")\n\n# Public content', { pdf: false });
  assert.equal(result.diagnostics.filter(item => item.code === 'include').length, 2);
  assert.ok(result.webHtml.includes('Public content'));
  assert.ok(!result.webHtml.includes('Private sibling'));
});

test('bibliography changes are reread and CSL-style data is normalized', async t => {
  const { root, compiler } = await fixture(t);
  const bibliography = path.join(root, 'references.json');
  await fs.writeFile(bibliography, JSON.stringify([{ id: 'a', title: 'Original title', author: [{ given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [[1843]] } }]));
  const source = '# Citations\n\nEarlier work @cite("a").\n\n@bibliography("references.json")';
  const first = await compiler.compile(source, { pdf: false });
  assert.equal(first.document.bibliographyData.a.author[0], 'Ada Lovelace');
  assert.equal(first.document.bibliographyData.a.year, 1843);
  assert.ok(first.webHtml.includes('Original title'));
  await fs.writeFile(bibliography, JSON.stringify({ a: { title: 'Updated title', year: 1844 } }));
  const second = await compiler.compile(source, { pdf: false });
  assert.ok(second.webHtml.includes('Updated title'));
  assert.notEqual(first.document.dependencies[0].hash, second.document.dependencies[0].hash);
});

test('static figures preserve dimensions while active SVG and remote resources are rejected', async t => {
  const { root, compiler } = await fixture(t);
  await fs.writeFile(path.join(root, 'safe.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#123456"/></svg>');
  await fs.writeFile(path.join(root, 'script.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await fs.writeFile(path.join(root, 'remote.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/image.svg#x"/></svg>');
  const result = await compiler.compile('@figure("safe.svg", width: 100, alt: "A rectangle")\n@figure("script.svg")\n@figure("remote.svg")', { pdf: false });
  assert.equal(result.document.blocks[0].asset.width, 100);
  assert.equal(result.document.blocks[0].asset.height, 50);
  assert.equal(result.diagnostics.filter(item => item.code === 'figure').length, 2);
  assert.ok(!result.html.includes('<script>alert'));
});

test('nested includes resolve paths relative to each containing file and keep source mappings', async t => {
  const { root, compiler } = await fixture(t);
  await fs.mkdir(path.join(root, 'chapters'));
  await fs.writeFile(path.join(root, 'chapters', 'one.ex'), '# One\n\n@include("two.ex")');
  await fs.writeFile(path.join(root, 'chapters', 'two.ex'), 'A nested paragraph.');
  const result = await compiler.compile('@include("chapters/one.ex")', { pdf: false });
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  assert.equal(result.document.blocks[1].text, 'A nested paragraph.');
  assert.match(result.document.blocks[1].source.file, /chapters\/two\.ex$/);
  assert.equal(result.stats.dependencyFiles, 2);
});

test('missing project dependencies remain observable and recover after creation', async t => {
  const { root, compiler } = await fixture(t);
  const source = '@include("new/chapter.ex")\n\n# Main document';
  const missing = await compiler.compile(source, { pdf: false });
  assert.ok(missing.diagnostics.some(diagnostic => diagnostic.code === 'include'));
  assert.equal(missing.document.dependencies[0].missing, true);
  assert.match(missing.document.dependencies[0].resolved, /new\/chapter\.ex$/);
  await fs.mkdir(path.join(root, 'new'));
  await fs.writeFile(path.join(root, 'new', 'chapter.ex'), 'A newly created chapter.');
  const recovered = await compiler.compile(source, { pdf: false });
  assert.ok(!recovered.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
  assert.ok(recovered.webHtml.includes('A newly created chapter.'));
});

test('cache clear removes reusable paragraph results without changing output', async t => {
  const { compiler } = await fixture(t);
  const source = '# Cache\n\nA stable paragraph with several words.';
  await compiler.compile(source, { pdf: false });
  const warm = await compiler.compile(source, { pdf: false });
  assert.ok(warm.stats.cacheHits > 0);
  compiler.clearCache();
  const fresh = await compiler.compile(source, { pdf: false });
  assert.equal(fresh.stats.cacheHits, 0);
  assert.equal(warm.html, fresh.html);
});
