import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createCompiler } from './compiler.js';
import { renderPdf } from './render.js';

const compiler = createCompiler({ rootDir: workerData.rootDir });
const snapshots = new Map();
let queue = Promise.resolve();

function checkCancelled(flag) {
  if (flag && Atomics.load(flag, 0)) {
    const error = new Error('Compilation superseded by a newer edit.');
    error.name = 'AbortError';
    throw error;
  }
}

async function execute(message) {
  const { id, type, payload } = message;
  try {
    parentPort.postMessage({ id, event: 'started' });
    if (type === 'compile') {
      const { source, options, exportId } = payload;
      checkCancelled(options.cancelFlag);
      const result = await compiler.compile(source, options);
      checkCancelled(options.cancelFlag);
      // PDF rendering consumes metadata and positioned pages. Avoid retaining
      // parser trees, resolver closures and dependency content for every edit.
      snapshots.set(exportId, result.pdf
        ? { pdf: result.pdf }
        : { document: { metadata: { ...result.document.metadata } }, layout: result.layout });
      while (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
      // Document models contain resolver functions. Keep the complete model in
      // the worker; the HTTP thread only needs output and measured statistics.
      parentPort.postMessage({ id, result: { html: result.html, webHtml: result.webHtml, pdf: result.pdf, stats: result.stats, diagnostics: result.diagnostics || [], exportId } });
    } else if (type === 'pdf') {
      const snapshot = snapshots.get(payload.exportId);
      if (!snapshot) { const error = new Error('This export expired. Compile the document again.'); error.status = 410; throw error; }
      const started = performance.now();
      snapshot.pdf ||= await renderPdf(snapshot.document, snapshot.layout);
      delete snapshot.document;
      delete snapshot.layout;
      parentPort.postMessage({ id, result: { pdf: snapshot.pdf, exportMs: performance.now() - started } });
    } else {
      throw new Error(`Unknown compiler worker operation: ${type}`);
    }
  } catch (error) {
    parentPort.postMessage({ id, error: { name: error.name, message: error.message, status: error.status } });
  }
}

// Compilation is serialized to keep its cache predictable. The HTTP thread can
// change shared cancellation flags even while this worker is in synchronous
// typography or layout code; obsolete queued work is skipped before it starts.
parentPort.on('message', message => { queue = queue.then(() => execute(message)); });
