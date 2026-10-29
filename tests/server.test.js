import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startServer, MAX_SOURCE_BYTES } from '../src/server.js';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-server-'));
  await fs.mkdir(path.join(root, 'examples'));
  await fs.writeFile(path.join(root, 'examples', 'hello.ex'), '@title "Hello example"\n\n# Hello\n');
  await fs.writeFile(path.join(root, 'private.txt'), 'never expose this file');
  const compiler = overrides.compiler || { async compile(source) { return { html: `<p>${source}</p>`, webHtml: `<article>${source}</article>`, pdf: Buffer.from(`%PDF-1.4\n${source}`), stats: { totalMs: 1, pages: 1 }, diagnostics: [] }; } };
  const running = await startServer({ rootDir: root, port: 0, compiler, pdfRenderer: overrides.pdfRenderer });
  t.after(async () => { await running.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { ...running, root };
}

function rawRequest(url, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: target.hostname, port: target.port, path: requestPath, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('playground serves only public assets and examples', async t => {
  const { url } = await fixture(t);
  const app = await fetch(url);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await app.text(), /Earlyx document source/);
  const examples = await (await fetch(`${url}/api/examples`)).json();
  assert.equal(examples[0].name, 'Hello example');
  assert.equal(examples[0].filename, 'examples/hello.ex');
  assert.equal((await fetch(`${url}/private.txt`)).status, 404);
  assert.equal((await fetch(`${url}/src/server.js`)).status, 404);
  assert.equal((await fetch(`${url}/artifacts/`)).status, 404);
});

test('each compilation gets immutable PDF output with the right MIME type', async t => {
  const { url } = await fixture(t);
  async function compile(source, revision) {
    const response = await fetch(`${url}/api/compile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, revision }) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const first = await compile('first', 1);
  const second = await compile('second', 2);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(first.pdfUrl, second.pdfUrl);
  const pdf = await fetch(url + first.pdfUrl);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await pdf.text(), '%PDF-1.4\nfirst');
  assert.equal((await fetch(url + first.pdfUrl, { method: 'HEAD' })).status, 200);
});

test('source errors remain successful inspectable compilation responses', async t => {
  const compiler = { async compile() { return { html: '<p>Partial output</p>', webHtml: '<p>Partial output</p>', stats: {}, diagnostics: [{ severity: 'error', message: 'Unclosed expression', source: { line: 2 } }] }; } };
  const { url } = await fixture(t, { compiler });
  const response = await fetch(`${url}/api/compile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'invalid source' }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.equal(result.pdfUrl, null);
});

test('lazy PDF export preserves each immutable compilation and renders once on demand', async t => {
  let exports = 0;
  const options = [];
  const compiler = { async compile(source, config) {
    options.push(config);
    return { html: `<p>${source}</p>`, webHtml: `<p>${source}</p>`, document: { title: source }, layout: { text: source }, stats: { totalMs: 1 }, diagnostics: [] };
  } };
  const pdfRenderer = async (document, layout) => { exports++; return Buffer.from(`%PDF-1.4\n${document.title}:${layout.text}`); };
  const { url } = await fixture(t, { compiler, pdfRenderer });
  const compile = async source => (await fetch(`${url}/api/compile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, pdf: false }) })).json();
  const first = await compile('original');
  const second = await compile('updated');
  assert.equal(options[0].pdf, false);
  assert.equal(first.stats.pdfIncluded, false);
  assert.equal(first.stats.exportMode, 'lazy');
  assert.equal(exports, 0, 'preview compilation must not export a PDF');
  const [one, two] = await Promise.all([fetch(url + first.pdfUrl), fetch(url + first.pdfUrl)]);
  assert.equal(await one.text(), '%PDF-1.4\noriginal:original');
  assert.equal(await two.text(), '%PDF-1.4\noriginal:original');
  assert.equal(exports, 1, 'concurrent downloads share the same PDF render');
  assert.equal(one.headers.get('content-type'), 'application/pdf');
  assert.ok(Number(one.headers.get('x-earlyx-export-ms')) >= 0);
  assert.equal(await (await fetch(url + second.pdfUrl)).text(), '%PDF-1.4\nupdated:updated');
  assert.equal(exports, 2);
});

test('request validation rejects cross-origin, traversal, symlinks and oversized source', async t => {
  const { url, root } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-private-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'artifacts', 'secret.txt'));
  assert.equal((await fetch(`${url}/artifacts/secret.txt`)).status, 403);
  assert.equal((await rawRequest(url, '/artifacts/..%2f..%2fprivate.txt')).status, 403);
  assert.equal((await rawRequest(url, '/artifacts/%ZZ')).status, 400);
  assert.equal((await rawRequest(url, '/', { Host: 'attacker.example' })).status, 403);
  assert.equal((await fetch(`${url}/api/examples`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${url}/api/compile`, { method: 'POST', body: '{}' })).status, 415);
  const post = (value) => fetch(`${url}/api/compile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post({ source: 'x', filename: '../private.ex' })).status, 403);
  assert.equal((await post({ source: 'x'.repeat(MAX_SOURCE_BYTES + 1) })).status, 413);
  assert.equal((await post({ source: 12 })).status, 400);
});

test('server refuses a writable artifact directory that escapes the project', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-symlink-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-outside-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.symlink(outside, path.join(root, 'artifacts'));
  await assert.rejects(startServer({ rootDir: root, port: 0, compiler: {} }), /symlink leaves/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a failed listener closes its compiler worker instead of keeping the CLI alive', async t => {
  const { url, root } = await fixture(t);
  let shutdowns = 0;
  const compiler = { close() { shutdowns++; } };
  await assert.rejects(startServer({ rootDir: root, port: Number(new URL(url).port), compiler }), { code: 'EADDRINUSE' });
  assert.equal(shutdowns, 1);
});
