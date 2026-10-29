const $ = (id) => document.getElementById(id);
const editor = $('source-input');
const frame = $('preview-frame');
const tabs = [...document.querySelectorAll('[data-mode]')];
const fallbackSource = `@title "A smaller language. A bigger canvas."
@author "The Earlyx team"

# A document starts with an idea

Earlyx brings **clear writing** and thoughtful typography together. Write once, then publish a paged document, a responsive website, or a PDF.

## Make room for the interesting parts

- A preview that keeps up with your thoughts.
- Equations that belong on the page.
- One source for every output.

$$
E = mc^2
$$

Your next great idea goes here.
`;

const state = { revision: 0, mode: 'paged', previewMode: null, scroll: { paged: [0, 0], web: [0, 0] }, result: null, filename: 'untitled.ex', examples: [], controller: null, timer: null, roundtrip: 0 };
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const milliseconds = (value) => Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)} ms` : '—';
const plural = (count, label) => `${count} ${label}${count === 1 ? '' : 's'}`;

function setStatus(text, kind = 'ready') {
  $('status-text').textContent = text;
  $('compile-status').dataset.state = kind;
}

function updateSourceInfo() {
  const lines = editor.value.split('\n').length;
  $('line-numbers').textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n');
  $('source-count').textContent = `${plural(lines, 'line')} · UTF-8`;
  $('source-filename').textContent = state.filename.split('/').pop();
  $('line-numbers').scrollTop = editor.scrollTop;
}

function selectSource(start, end, line, file) {
  if (file && file !== state.filename && !file.endsWith(`/${state.filename.replace(/^\.\//, '')}`)) {
    const includes = [...editor.value.matchAll(/@include\(\s*["']([^"']+)["']/g)];
    const include = includes.find(match => file.endsWith(`/${match[1]}`));
    if (include) {
      selectSource(include.index, include.index + include[0].length);
      setStatus(`Content from ${file.split('/').pop()} · include selected`);
    } else setStatus(`Source belongs to included file ${file.split('/').pop()}`);
    return;
  }
  let from = Number(start);
  let to = Number(end);
  if (!Number.isFinite(from) && Number.isFinite(Number(line))) {
    const lines = editor.value.split('\n');
    const index = Math.max(0, Math.min(lines.length - 1, Number(line) - 1));
    from = lines.slice(0, index).reduce((length, text) => length + text.length + 1, 0);
    to = from + lines[index].length;
  }
  if (!Number.isFinite(from)) return;
  if (!Number.isFinite(to)) to = from;
  editor.focus();
  editor.setSelectionRange(Math.max(0, from), Math.max(from, to));
  const precedingLines = editor.value.slice(0, from).split('\n').length - 1;
  editor.scrollTop = Math.max(0, precedingLines * 22 - editor.clientHeight / 3);
  $('line-numbers').scrollTop = editor.scrollTop;
}

function showDiagnostics(diagnostics = []) {
  const list = $('diagnostic-list');
  list.replaceChildren();
  $('diagnostics').hidden = !diagnostics.length;
  if (!diagnostics.length) return;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  $('diagnostic-summary').textContent = errors ? `${plural(errors, 'error')} · ${plural(diagnostics.length, 'message')}` : plural(diagnostics.length, 'compiler message');
  for (const diagnostic of diagnostics) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const source = diagnostic.source ?? diagnostic.location ?? {};
    const line = source.line ?? diagnostic.line;
    const severity = diagnostic.severity ?? 'warning';
    button.type = 'button';
    button.className = 'diagnostic-button';
    button.innerHTML = `<span class="diagnostic-kind ${severity === 'warning' ? 'warning' : ''}">${escapeHTML(severity)}</span>${line ? `<span class="diagnostic-location">L${escapeHTML(line)}</span>` : ''}<span>${escapeHTML(diagnostic.message ?? String(diagnostic))}</span>`;
    button.addEventListener('click', () => selectSource(source.start, source.end, line, source.file || diagnostic.file));
    item.append(button);
    list.append(item);
  }
}

function showStats(stats = {}) {
  $('stats-total').textContent = milliseconds(stats.totalMs);
  $('stats-layout').textContent = milliseconds(stats.layoutMs);
  $('stats-parse').textContent = milliseconds(stats.parseMs);
  $('stats-layout-detail').textContent = milliseconds(stats.layoutMs);
  $('stats-render').textContent = milliseconds(stats.renderMs);
  $('stats-roundtrip').textContent = milliseconds(state.roundtrip);
  const hits = Number(stats.cacheHits) || 0;
  const misses = Number(stats.cacheMisses) || 0;
  $('stats-cache').textContent = hits + misses ? `${Math.round(hits / (hits + misses) * 100)}% reuse` : '—';
  $('stats-reuse').textContent = `${hits} reused / ${misses} new`;
  $('page-count').textContent = Number.isFinite(Number(stats.pages)) ? plural(Number(stats.pages), 'page') : '— pages';
}

function emptyDocument(title, message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(title)}</title><style>html{color-scheme:light}body{margin:0;padding:48px 32px;background:#e9e8e4;color:#303644;font:14px/1.7 system-ui}h1{font-size:22px;font-weight:500}p{color:#697080;max-width:360px}</style><h1>${escapeHTML(title)}</h1><p>${escapeHTML(message)}</p></html>`;
}

function renderPreview() {
  const result = state.result;
  if (!result) return;
  if (state.previewMode && state.previewMode !== 'pdf') {
    try { state.scroll[state.previewMode] = [frame.contentWindow.scrollX, frame.contentWindow.scrollY]; } catch { /* The frame may still be loading. */ }
  }
  state.previewMode = state.mode;
  $('preview-empty').hidden = true;
  frame.title = `${state.mode === 'paged' ? 'Paged' : state.mode === 'web' ? 'Responsive web' : 'PDF'} document preview`;
  if (state.mode === 'pdf') {
    frame.removeAttribute('srcdoc');
    if (result.pdfUrl && new URL(result.pdfUrl, location.href).origin === location.origin) {
      // The local PDF viewer needs its browser plugin; HTML previews stay sandboxed.
      frame.removeAttribute('sandbox');
      frame.src = result.pdfUrl;
    } else {
      frame.removeAttribute('src');
      frame.srcdoc = emptyDocument('PDF unavailable', 'Resolve the compiler errors to export this document as a PDF.');
    }
  } else {
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.removeAttribute('src');
    frame.srcdoc = state.mode === 'web' ? result.webHtml || emptyDocument('Web preview unavailable', 'The compiler has not returned responsive HTML for this document.') : result.html || emptyDocument('Paged preview unavailable', 'Resolve the compiler errors to render this document.');
  }
  $('preview-description').textContent = state.mode === 'paged' ? 'Fixed pages · matches PDF layout' : state.mode === 'web' ? 'Responsive HTML · adapts to screen width' : 'PDF · final document';
  document.querySelector('.preview-hint').style.visibility = state.mode === 'pdf' ? 'hidden' : 'visible';
}

function setMode(mode, focus = false) {
  state.mode = mode;
  tabs.forEach((tab) => {
    const selected = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  $('preview-content').setAttribute('aria-labelledby', `${mode}-tab`);
  $('download-html').textContent = mode === 'web' ? '↓ Web HTML' : '↓ HTML';
  renderPreview();
}

async function compile() {
  clearTimeout(state.timer);
  state.controller?.abort();
  const revision = state.revision;
  const controller = new AbortController();
  state.controller = controller;
  setStatus('Compiling document', 'loading');
  const started = performance.now();
  try {
    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: editor.value, filename: state.filename, revision, pdf: false }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (revision !== state.revision || controller.signal.aborted) return;
    if (!response.ok) {
      showDiagnostics(result.diagnostics ?? [{ severity: 'error', message: result.error ?? result.message ?? `Compilation failed (${response.status}).` }]);
      setStatus('Build failed · previous preview retained', 'error');
      return;
    }
    if (result.revision !== undefined && result.revision !== revision) return;
    state.roundtrip = performance.now() - started;
    state.result = result;
    showStats(result.stats);
    showDiagnostics(result.diagnostics);
    renderPreview();
    const hasErrors = result.diagnostics?.some((diagnostic) => diagnostic.severity === 'error');
    const warnings = result.diagnostics?.filter((diagnostic) => diagnostic.severity === 'warning').length || 0;
    setStatus(hasErrors ? 'Preview updated · source needs attention' : warnings ? `Compiled with ${plural(warnings, 'warning')}` : 'Up to date', hasErrors ? 'error' : 'ready');
    $('unsaved-indicator').hidden = true;
    $('download-pdf').disabled = !result.pdfUrl;
    $('download-html').disabled = !result.html && !result.webHtml;
  } catch (error) {
    if (error.name === 'AbortError' || revision !== state.revision) return;
    setStatus('Compiler unavailable', 'error');
    showDiagnostics([{ severity: 'error', message: `Could not reach the local compiler. ${error.message}` }]);
  } finally {
    if (state.controller === controller) state.controller = null;
  }
}

function scheduleCompile() {
  state.revision++;
  state.controller?.abort();
  clearTimeout(state.timer);
  $('unsaved-indicator').hidden = false;
  $('download-pdf').disabled = true;
  $('download-html').disabled = true;
  setStatus('Source changed · updating preview', 'stale');
  updateSourceInfo();
  state.timer = setTimeout(compile, 120);
}

function downloadFile(content, mime, name) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadExample(example) {
  state.filename = example.filename || `${example.name || 'untitled'}.ex`;
  editor.value = example.source;
  editor.scrollTop = 0;
  editor.setSelectionRange(0, 0);
  state.scroll = { paged: [0, 0], web: [0, 0] };
  state.previewMode = null;
  scheduleCompile();
}

editor.addEventListener('input', scheduleCompile);
editor.addEventListener('scroll', () => { $('line-numbers').scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText('  ', start, end, 'end');
    scheduleCompile();
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    compile();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    downloadFile(editor.value, 'text/plain;charset=utf-8', state.filename.split('/').pop());
  }
});
$('compile-button').addEventListener('click', compile);
$('example-select').addEventListener('change', (event) => {
  const example = state.examples[Number(event.target.value)];
  if (example) loadExample(example);
});
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); setMode(tabs[next].dataset.mode, true); }
  });
});
$('timing-toggle').addEventListener('click', () => {
  const open = $('timing-details').hidden;
  $('timing-details').hidden = !open;
  $('timing-toggle').setAttribute('aria-expanded', String(open));
});
$('download-html').addEventListener('click', () => {
  if (!state.result) return;
  const web = state.mode === 'web';
  const html = web ? state.result.webHtml : state.result.html;
  if (html) downloadFile(html, 'text/html;charset=utf-8', `${state.filename.split('/').pop().replace(/\.[^.]+$/, '')}${web ? '.web' : ''}.html`);
});
$('download-pdf').addEventListener('click', () => {
  if (!state.result?.pdfUrl) return;
  const link = document.createElement('a');
  link.href = state.result.pdfUrl;
  link.download = `${state.filename.split('/').pop().replace(/\.[^.]+$/, '')}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
});
frame.addEventListener('load', () => {
  if (state.mode === 'pdf') return;
  try {
    const [left, top] = state.scroll[state.mode] || [0, 0];
    frame.contentWindow?.scrollTo(left, top);
    frame.contentDocument?.addEventListener('click', (event) => {
      const target = event.target.closest('[data-source-start], [data-source-line], [data-source]');
      if (!target) return;
      // Preserve links so the published HTML remains useful in the preview.
      if (event.target.closest('a[href]')) return;
      event.preventDefault();
      selectSource(target.dataset.sourceStart, target.dataset.sourceEnd, target.dataset.sourceLine || target.dataset.source, target.dataset.sourceFile);
    });
  } catch { /* Browser PDF viewers do not expose their document to the editor. */ }
});

async function start() {
  editor.value = fallbackSource;
  updateSourceInfo();
  try {
    const response = await fetch('/api/examples');
    if (!response.ok) throw new Error(`Examples unavailable (${response.status}).`);
    const payload = await response.json();
    state.examples = (Array.isArray(payload) ? payload : payload.examples || []).filter((example) => typeof example.source === 'string');
  } catch { state.examples = []; }
  const select = $('example-select');
  select.replaceChildren();
  if (!state.examples.length) state.examples = [{ name: 'Getting started', filename: 'untitled.ex', source: fallbackSource }];
  state.examples.forEach((example, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = example.name || example.filename;
    select.append(option);
  });
  loadExample(state.examples[0]);
}

start();
