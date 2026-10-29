import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerCompiler } from '../src/worker-client.js';

test('persistent compiler worker reuses layouts and exports old snapshots lazily', async t => {
  const compiler = createWorkerCompiler({ rootDir: process.cwd() });
  t.after(() => compiler.close());
  const first = await compiler.compile('@title "First immutable title"\n\n# A worker document\n\nA paragraph to cache.', { filename: 'worker.ex', pdf: false });
  const second = await compiler.compile('@title "Second immutable title"\n\n# A worker document\n\nA paragraph to cache.', { filename: 'worker.ex', pdf: false });
  assert.equal(first.pdf, undefined);
  assert.notEqual(first.exportId, second.exportId);
  assert.ok(second.stats.cacheHits > 0);
  const original = await compiler.renderPdf(first.exportId);
  const updated = await compiler.renderPdf(second.exportId);
  assert.equal(Buffer.from(original.pdf).subarray(0, 4).toString(), '%PDF');
  assert.match(Buffer.from(original.pdf).toString('latin1'), /First immutable title/);
  assert.doesNotMatch(Buffer.from(original.pdf).toString('latin1'), /Second immutable title/);
  assert.match(Buffer.from(updated.pdf).toString('latin1'), /Second immutable title/);
  assert.ok(original.exportMs >= 0);
});

test('shared cancellation skips obsolete work and the worker remains usable', async t => {
  const compiler = createWorkerCompiler({ rootDir: process.cwd() });
  t.after(() => compiler.close());
  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancelFlag, 0, 1);
  await assert.rejects(compiler.compile('# Obsolete source', { filename: 'old.ex', pdf: false, cancelFlag }), { name: 'AbortError' });
  const current = await compiler.compile('# Current source', { filename: 'new.ex', pdf: false });
  assert.match(current.webHtml, /Current source/);
});

test('running compilation observes shared cancellation and recovers its cache', async t => {
  const compiler = createWorkerCompiler({ rootDir: process.cwd() });
  t.after(() => compiler.close());
  await compiler.compile('# Warm worker\n\nReady.', { filename: 'warm.ex', pdf: false });
  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  const longSource = Array.from({ length: 4000 }, (_, index) => `## Section ${index}\n\nA sufficiently long paragraph with mathematics $x^2$ and ordinary text for a cancellable document.\n`).join('\n');
  let started = false;
  const obsolete = compiler.compile(longSource, {
    filename: 'obsolete.ex', pdf: false, cancelFlag,
    onStart() { started = true; setTimeout(() => Atomics.store(cancelFlag, 0, 1), 20); },
  });
  await assert.rejects(obsolete, { name: 'AbortError' });
  assert.equal(started, true, 'cancellation must happen after the worker starts this task');
  const current = await compiler.compile('# Current after cancellation\n\nReady.', { filename: 'current.ex', pdf: false });
  assert.match(current.webHtml, /Current after cancellation/);
  assert.ok(current.stats.workerQueueMs >= 0);
});
