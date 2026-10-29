import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

/** A persistent worker keeps the paragraph cache while HTTP stays responsive. */
export function createWorkerCompiler({ rootDir }) {
  const worker = new Worker(new URL('./compile-worker.js', import.meta.url), { workerData: { rootDir } });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let fatal = null;

  const rejectAll = error => { fatal = error; for (const task of pending.values()) task.reject(error); pending.clear(); };
  worker.on('error', rejectAll);
  worker.on('exit', code => {
    if (!closed || pending.size) rejectAll(new Error(`Compiler worker stopped (${code}).`));
  });
  worker.on('message', message => {
    const task = pending.get(message.id);
    if (!task) return;
    if (message.event === 'started') {
      task.queueMs = performance.now() - task.enqueuedAt;
      task.onStart?.();
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.name = message.error.name || 'Error';
      error.status = message.error.status;
      task.reject(error);
    } else {
      if (message.result?.stats) message.result.stats.workerQueueMs = task.queueMs;
      task.resolve(message.result);
    }
  });

  function call(type, payload, onStart) {
    if (closed) return Promise.reject(new Error('Compiler worker has closed.'));
    if (fatal) return Promise.reject(fatal);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onStart, enqueuedAt: performance.now() });
      worker.postMessage({ id, type, payload });
    });
  }

  return {
    compile(source, { onStart, ...options } = {}) { return call('compile', { source, options, exportId: randomUUID() }, onStart); },
    renderPdf(exportId) { return call('pdf', { exportId }); },
    async close() {
      if (closed) return;
      closed = true;
      rejectAll(new Error('Compiler worker has closed.'));
      await worker.terminate();
    },
  };
}
