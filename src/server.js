import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createWorkerCompiler } from './worker-client.js';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 7 * MAX_SOURCE_BYTES;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function contained(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }

function sendJSON(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': mimeTypes['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function bodyJSON(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) { const error = new Error('Request body exceeds the maximum document size.'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Expected a JSON request body.'); error.status = 400; throw error; }
}

async function secureDirectory(root, relative) {
  const candidate = path.resolve(root, relative);
  if (!contained(root, candidate)) throw new Error('Directory must remain inside the project.');
  // Resolve the nearest existing ancestor before creating anything. A symlink
  // inside the project must not cause writes outside it.
  let ancestor = candidate;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!contained(root, real)) throw new Error('Directory symlink leaves the project.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  await fs.mkdir(candidate, { recursive: true });
  const real = await fs.realpath(candidate);
  if (!contained(root, real)) throw new Error('Directory must remain inside the project.');
  return real;
}

async function examples(root) {
  const records = [];
  const sampleDir = path.join(root, 'examples');
  async function visit(directory, depth = 0) {
    if (depth > 3 || records.length >= 100) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || records.length >= 100) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.ex')) continue;
      const real = await fs.realpath(file);
      if (!contained(root, real)) continue;
      if ((await fs.stat(real)).size > MAX_SOURCE_BYTES) continue;
      const source = await fs.readFile(real, 'utf8');
      const title = source.match(/^@title\s+["']([^"'\n]+)["']/m)?.[1];
      const filename = path.relative(root, real).split(path.sep).join('/');
      records.push({ name: title || entry.name.replace(/\.ex$/, '').replace(/[-_]/g, ' '), filename, source });
    }
  }
  // The examples directory itself may be a symlink; validate it before walking.
  try {
    const real = await fs.realpath(sampleDir);
    if (contained(root, real)) await visit(real);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return records;
}

async function serveFile(req, res, root, relative, appHTML = false) {
  const candidate = path.resolve(root, relative);
  if (!contained(root, candidate)) return sendJSON(res, 403, { error: 'Path is outside the served directory.' });
  let real, stat;
  try {
    real = await fs.realpath(candidate);
    if (!contained(root, real)) return sendJSON(res, 403, { error: 'Symlinks outside the served directory are not served.' });
    stat = await fs.stat(real);
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendJSON(res, 404, { error: 'Not found.' }); throw error; }
  if (!stat.isFile()) return sendJSON(res, 404, { error: 'Not found.' });
  const headers = {
    'Content-Type': mimeTypes[path.extname(real).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (appHTML) headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; frame-src 'self' blob:; connect-src 'self'; object-src 'self'; base-uri 'self'; frame-ancestors 'self'";
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(real);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Create the localhost playground server. `compiler` can be injected by tests. */
export async function createServer({ rootDir = process.cwd(), compiler, pdfRenderer } = {}) {
  const root = await fs.realpath(rootDir);
  const assetsRoot = await fs.realpath(webDir);
  const artifactRoot = await secureDirectory(root, 'artifacts');
  const liveRoot = await secureDirectory(root, 'artifacts/live');
  const engine = compiler || createWorkerCompiler({ rootDir: root });
  const liveExports = new Map();
  let pending = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return sendJSON(res, 403, { error: 'Only localhost requests are allowed.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJSON(res, 403, { error: 'Cross-origin requests are not allowed.' });
      const url = new URL(req.url, `http://${host}`);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { return sendJSON(res, 400, { error: 'Invalid URL encoding.' }); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) return sendJSON(res, 403, { error: 'Invalid path.' });

      if (pathname === '/api/compile' && req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return sendJSON(res, 415, { error: 'Use Content-Type: application/json.' });
        if (pending >= 8) return sendJSON(res, 429, { error: 'The compiler is busy. Try again shortly.' });
        const input = await bodyJSON(req);
        if (!input || typeof input.source !== 'string') return sendJSON(res, 400, { error: 'source must be a string.' });
        if (Buffer.byteLength(input.source, 'utf8') > MAX_SOURCE_BYTES) return sendJSON(res, 413, { error: 'Source exceeds the 1 MiB limit.' });
        const filename = typeof input.filename === 'string' ? input.filename : 'untitled.ex';
        if (filename.includes('\0') || !contained(root, path.resolve(root, filename))) return sendJSON(res, 403, { error: 'Source filename must remain inside the project.' });
        if (pending >= 8) return sendJSON(res, 429, { error: 'The compiler is busy. Try again shortly.' });
        pending++;
        const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
        res.once('close', () => { if (!res.writableEnded) Atomics.store(cancelFlag, 0, 1); });
        try {
          const includePdf = input.pdf !== false;
          const result = await engine.compile(input.source, { filename, pdf: includePdf, cancelFlag });
          if (res.destroyed) return;
          let pdfUrl = null;
          if (result.pdf?.length || result.exportId || (result.document && result.layout)) {
            // Immutable names prevent a late compilation from replacing the PDF
            // belonging to a newer editor revision.
            const filename = `${randomUUID()}.pdf`;
            if (result.pdf?.length) await fs.writeFile(path.join(liveRoot, filename), result.pdf, { flag: 'wx' });
            pdfUrl = `/artifacts/live/${filename}`;
            liveExports.set(filename, { exportId: result.exportId, document: result.document, layout: result.layout, ready: !!result.pdf?.length, promise: null });
            if (liveExports.size > 100) {
              const expired = liveExports.keys().next().value;
              liveExports.delete(expired);
              await fs.unlink(path.join(liveRoot, expired)).catch(() => {});
            }
          }
          return sendJSON(res, 200, { revision: input.revision, html: result.html, webHtml: result.webHtml, pdfUrl, stats: { ...result.stats, pdfIncluded: includePdf, exportMode: includePdf ? 'eager' : 'lazy' }, diagnostics: result.diagnostics || [], sourceMap: result.sourceMap });
        } finally { pending--; }
      }
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/examples' && req.method === 'GET') return sendJSON(res, 200, await examples(root));
        return sendJSON(res, pathname === '/api/compile' || pathname === '/api/examples' ? 405 : 404, { error: 'Unknown API route or unsupported method.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Method not allowed.' });
      if (pathname === '/' || pathname === '/index.html') return await serveFile(req, res, assetsRoot, 'index.html', true);
      if (pathname === '/app.js' || pathname === '/styles.css') return await serveFile(req, res, assetsRoot, pathname.slice(1));
      if (pathname.startsWith('/artifacts/live/') && pathname.endsWith('.pdf')) {
        const filename = pathname.slice('/artifacts/live/'.length);
        const snapshot = liveExports.get(filename);
        if (snapshot && !snapshot.ready) {
          snapshot.promise ||= (async () => {
            const started = performance.now();
            const exported = snapshot.exportId && engine.renderPdf
              ? await engine.renderPdf(snapshot.exportId)
              : { pdf: await (pdfRenderer || (await import('./render.js')).renderPdf)(snapshot.document, snapshot.layout) };
            await fs.writeFile(path.join(liveRoot, filename), exported.pdf, { flag: 'wx' });
            snapshot.ready = true;
            snapshot.exportMs = exported.exportMs ?? performance.now() - started;
            // Release the fallback in-thread document once its PDF exists.
            delete snapshot.document;
            delete snapshot.layout;
          })().catch(error => { snapshot.promise = null; throw error; });
          await snapshot.promise;
        }
        if (snapshot?.exportMs !== undefined) res.setHeader('X-Earlyx-Export-Ms', snapshot.exportMs.toFixed(3));
      }
      if (pathname.startsWith('/artifacts/')) return await serveFile(req, res, artifactRoot, pathname.slice('/artifacts/'.length));
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return sendJSON(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      sendJSON(res, error.status || 500, { error: error.status ? error.message : 'The local compiler could not complete this request.', diagnostics: [{ severity: 'error', message: error.message }] });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  let shutdownPromise;
  const shutdown = () => shutdownPromise ||= Promise.resolve().then(() => engine.close?.());
  server.earlyx = { rootDir: root, artifactRoot, shutdown };
  server.once('close', () => { shutdown().catch(() => {}); });
  return server;
}

export async function startServer({ port = 4317, host = '127.0.0.1', ...options } = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') throw new Error('The playground may only bind to localhost.');
  const server = await createServer(options);
  try {
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(port, host, () => { server.removeListener('error', failed); resolve(); });
    });
  } catch (error) {
    await server.earlyx.shutdown();
    throw error;
  }
  const address = server.address();
  const url = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
  return { server, url, close: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await server.earlyx.shutdown();
  } };
}

export { MAX_SOURCE_BYTES };
