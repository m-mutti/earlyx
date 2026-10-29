#!/usr/bin/env node
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'artifacts');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const round = number => Math.round(number * 100) / 100;

export const stageDefinitions = [
  { number: 1, name: 'Rendering feasibility', description: 'Shared page geometry; text, equation, table, and multilingual smoke fixture.', source: `@title "One source. Two views."
@author "Earlyx rendering prototype"

# Rendering feasibility

Earlyx produces PDF and paged HTML from one shared page layout. This paragraph checks typography, **emphasis**, and ordinary text extraction.

The same equation appears in both views: $E = mc^2$.

$$
\\frac{1}{n} \\sum_{i=1}^{n} x_i
$$

@table(caption: "One layout, several outputs", id: "outputs")
| Output | Purpose |
| --- | --- |
| PDF | Printable pages |
| Paged HTML | Faithful preview |
| Responsive HTML | Readable web publication |

## Writing systems

Korean: 안녕하세요. Arabic: مرحبا بالعالم. These are smoke samples, not proof of full multilingual coverage.
` },
  { number: 2, name: 'Language and diagnostics', description: 'Structured source, local styles, source locations, reusable content, and recoverable diagnostics.', source: `@title "A language for documents"
@author "Earlyx language milestone"
@style(fontSize: 11, lineHeight: 1.45, color: "#202a38")

# A small, readable language

Documents contain structure rather than drawing instructions. **Strong text**, *emphasis*, and [a link](https://example.com) stay meaningful in web output.

- Headings and lists are ordinary source text.
- Equations use familiar notation: $a^2 + b^2 = c^2$.
- Styles are declared explicitly.

## Source locations

The editor can connect a rendered paragraph back to its source. Each compile reports diagnostics instead of executing arbitrary code.

\`\`\`js
const document = "plain text";
\`\`\`
` },
  { number: 3, name: 'Incremental live preview', description: 'Cached paragraph layout and warm local-edit measurements; editor interaction checked separately.', source: `@title "An edit should feel immediate"
@author "Earlyx preview milestone"

# Incremental preview

Change this paragraph and watch the preview update. Unchanged blocks should reuse cached layout.

## Stable content

This section remains unchanged during the edit benchmark. Keeping it stable gives the compiler useful work to reuse.

The compiler must still recompute affected pagination: adding a word can move later content onto another page.

$$
f(x) = \\int_0^x t^2 \\, dt
$$
` },
  { number: 4, name: 'Practical authoring', description: 'Article fixture with figures, tables, references, citations, notes, and responsive publication.', example: 'showcase.ex' },
  { number: 5, name: 'Reliability and distribution', description: 'Long-document edit benchmark, deterministic layout, independent PDF inspection, and distribution smoke checks.', source: `@title "Publishing with confidence"
@author "Earlyx verification milestone"

# Verified output

This report records measured compilation times and links directly to the rendered artifacts. PDF page sizes and text extraction are inspected independently with PDF.js.

## Reproducible layout

The same source and bundled fonts should produce the same positioned layout in a fresh compiler and in a compiler with cached content.

## Honest limits

Visual consistency is a geometry guarantee. Responsive HTML changes wrapping, and accessibility conformance requires broader testing than this automated smoke suite.
` },
];

export async function inspectPdf(buffer, layout, requiredText = []) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), verbosity: 0, useSystemFonts: false });
  const pdf = await task.promise;
  const pageInfo = [];
  const extracted = [];
  try {
    if (pdf.numPages !== layout.pages.length) throw new Error(`PDF has ${pdf.numPages} pages; shared layout has ${layout.pages.length}.`);
    for (let index = 0; index < pdf.numPages; index++) {
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const expected = layout.pages[index];
      const delta = Math.max(Math.abs(viewport.width - expected.width), Math.abs(viewport.height - expected.height));
      if (delta > 0.02) throw new Error(`Page ${index + 1}: PDF dimensions diverge from shared layout by ${delta}pt.`);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str ?? '').join(' ');
      extracted.push(text);
      const textItems = content.items.filter(item => typeof item.str === 'string' && item.str.trim());
      // PDF.js independently decodes the PDF text matrix. Match actual strings to
      // known text runs and compare their baseline origins in points.
      const candidates = expected.items.filter(item => item.type === 'text' && item.text?.trim());
      const checked = [];
      const consumed = new Set();
      for (const source of candidates) {
        const matches = textItems.map((item, index) => ({ item, index })).filter(({ item, index }) => !consumed.has(index) && source.text.trim() === item.str.trim());
        const nearest = matches.sort((left, right) => Math.hypot(left.item.transform[4] - source.x, expected.height - left.item.transform[5] - source.y) - Math.hypot(right.item.transform[4] - source.x, expected.height - right.item.transform[5] - source.y))[0];
        const actual = nearest?.item;
        if (!actual) continue;
        consumed.add(nearest.index);
        const xDelta = Math.abs(actual.transform[4] - source.x);
        const yDelta = Math.abs((expected.height - actual.transform[5]) - source.y);
        if (xDelta > 0.05 || yDelta > 0.05) throw new Error(`Page ${index + 1}: PDF text origin for ${JSON.stringify(actual.str)} diverges by x=${xDelta.toFixed(4)}pt, y=${yDelta.toFixed(4)}pt.`);
        checked.push({ text: actual.str, xDelta: round(xDelta), yDelta: round(yDelta) });
      }
      pageInfo.push({ number: index + 1, width: viewport.width, height: viewport.height, textItems: textItems.length, matchedTextOrigins: checked.length, textOrigins: checked });
    }
    const text = extracted.join('\n');
    const normalized = text.replace(/\s+/g, ' ');
    for (const phrase of requiredText) {
      if (!normalized.includes(phrase.replace(/\s+/g, ' '))) throw new Error(`PDF text extraction is missing ${JSON.stringify(phrase)}.`);
    }
    if (requiredText.length && !pageInfo.some(page => page.matchedTextOrigins > 0)) throw new Error('Independent PDF inspection did not match any intact text-run origins.');
    return { pages: pdf.numPages, pageInfo, text, requiredText };
  } finally { await task.destroy(); }
}

export function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

export function longDocumentSource(pages = 20) {
  return `@title "Twenty-page edit benchmark"\n@style(fontSize: 11, lineHeight: 1.4)\n\n` + Array.from({ length: pages }, (_, index) => `# Section ${index + 1}\n\n` + Array.from({ length: 6 }, (__, paragraph) => `Paragraph ${paragraph + 1} on section ${index + 1}. This benchmark uses stable paragraphs with enough text to exercise line breaking and source mapping. The compiler should reuse unchanged paragraph layouts while still calculating correct page positions. Edit marker: ORIGINAL.`).join('\n\n') + (index < pages - 1 ? '\n\n@pagebreak()\n\n' : '\n')).join('');
}

async function captureStage(definition, options) {
  const { createCompiler } = await import('../src/compiler.js');
  const time = new Date();
  const runId = time.toISOString().replace(/[:.]/g, '-');
  const relativeDir = `stage-${definition.number}/${runId}`;
  const directory = path.join(artifactRoot, relativeDir);
  await mkdir(directory, { recursive: true });
  let source = definition.source;
  let filename = path.join(directory, 'document.ex');
  if (definition.example) {
    const candidates = await readdir(path.join(root, 'examples'));
    const preferred = candidates.includes(definition.example) ? definition.example : candidates.find(name => /showcase|article/.test(name) && name.endsWith('.ex'));
    if (!preferred) throw new Error('Stage 4 needs examples/showcase.ex or an article example.');
    filename = path.join(root, 'examples', preferred);
    source = await readFile(filename, 'utf8');
  }
  await writeFile(path.join(directory, 'document.ex'), source);
  const compiler = createCompiler({ rootDir: root });
  const start = performance.now();
  const result = await compiler.compile(source, { filename, pdf: true });
  const wallMs = performance.now() - start;
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length) throw new Error(`Stage ${definition.number} fixture has errors: ${errors.map(error => error.message).join('; ')}`);
  if (!result.pdf?.length || !result.html?.length || !result.webHtml?.length) throw new Error('Compiler did not produce all three output artifacts.');
  const independent = await inspectPdf(result.pdf, result.layout, definition.number === 1 ? ['Earlyx', '안녕하세요'] : []);
  const snapshotRoot = path.join(directory, 'source');
  const entryRelative = definition.example ? path.relative(root, filename) : 'document.ex';
  const snapshotEntry = path.join(snapshotRoot, entryRelative);
  await mkdir(path.dirname(snapshotEntry), { recursive: true });
  await writeFile(snapshotEntry, source);
  const snapshotFiles = [{ path: entryRelative, kind: 'document', sha256: createHash('sha256').update(source).digest('hex') }];
  const copied = new Set([entryRelative]);
  for (const dependency of result.document.dependencies || []) {
    if (dependency.missing || !dependency.resolved) continue;
    const relative = path.relative(root, dependency.resolved);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Snapshot dependency is outside the compiler project.');
    if (copied.has(relative)) continue;
    copied.add(relative);
    const content = await readFile(dependency.resolved);
    const target = path.join(snapshotRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    snapshotFiles.push({ path: relative, kind: dependency.kind, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const sourceSnapshot = { root: 'source', entry: `source/${entryRelative.split(path.sep).join('/')}`, files: snapshotFiles };
  await writeFile(path.join(snapshotRoot, 'manifest.json'), JSON.stringify(sourceSnapshot, null, 2));
  const archive = spawnSync('tar', ['-czf', path.join(directory, 'source.tar.gz'), '-C', snapshotRoot, '.'], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`Could not archive source snapshot: ${archive.stderr || archive.error}`);
  await Promise.all([
    writeFile(path.join(directory, 'document.html'), result.html),
    writeFile(path.join(directory, 'document.web.html'), result.webHtml),
    writeFile(path.join(directory, 'document.pdf'), result.pdf),
    writeFile(path.join(directory, 'document.layout.json'), JSON.stringify(result.layout, null, 2)),
    writeFile(path.join(directory, 'document.text.txt'), independent.text),
  ]);
  const repeats = [];
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const editedSource = source + `\n\nA measured local edit, revision ${iteration}.\n`;
    const begin = performance.now();
    const edit = await compiler.compile(editedSource, { filename, pdf: false });
    repeats.push({ iteration, wallMs: round(performance.now() - begin), ...edit.stats });
  }
  const report = {
    stage: definition.number, name: definition.name, description: definition.description,
    capturedAt: time.toISOString(), relativeDir, sourceSha256: createHash('sha256').update(source).digest('hex'),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    compile: { wallMs: round(wallMs), ...result.stats },
    output: { pages: result.layout.pages.length, pdfBytes: result.pdf.length, pagedHtmlBytes: Buffer.byteLength(result.html), responsiveHtmlBytes: Buffer.byteLength(result.webHtml) },
    diagnostics: result.diagnostics,
    sourceSnapshot,
    warmEdit: { iterations: repeats.length, p50Ms: round(percentile(repeats.map(item => item.wallMs), 0.5)), p95Ms: round(percentile(repeats.map(item => item.wallMs), 0.95)), samples: repeats, scope: 'Preview output only (pdf:false), append-one-paragraph edits; same compiler instance.' },
    pdfInspection: independent,
    checks: { pdfPageCount: true, pdfPageDimensions: true, textExtraction: true },
    note: 'An actual capture of this fixture with the compiler available at capturedAt; stage numbers identify acceptance scope, not an assertion about past compiler versions.'
  };
  if (!options.skipCold) {
    const coldDir = path.join(directory, 'cold-cli');
    const begin = performance.now();
    const child = spawnSync(process.execPath, [path.join(root, 'bin', 'earlyx.js'), 'compile', snapshotEntry, '--root', snapshotRoot, '--out', coldDir], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    report.coldCli = { wallMs: round(performance.now() - begin), exitCode: child.status, stdout: child.stdout?.trim(), stderr: child.stderr?.trim() };
    if (child.status !== 0) throw new Error(`Cold CLI failed: ${child.stderr || child.stdout || child.error}`);
  }
  if (definition.number >= 3) report.longDocument = await benchmarkLongDocument(createCompiler, options.iterations);
  if (definition.number === 5) report.validation = await captureValidation(directory);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(directory, 'index.html'), captureHtml(report));
  await writeFile(path.join(artifactRoot, `stage-${definition.number}`, 'latest.json'), JSON.stringify(report, null, 2));
  await regenerateIndex();
  console.log(JSON.stringify({ stage: report.stage, name: report.name, compileMs: report.compile.wallMs, pages: report.output.pages, warmEditP50Ms: report.warmEdit.p50Ms, warmEditP95Ms: report.warmEdit.p95Ms, coldCliMs: report.coldCli?.wallMs, report: path.join(directory, 'index.html'), longDocument: report.longDocument ? { pages: report.longDocument.pages, p50Ms: report.longDocument.p50Ms, p95Ms: report.longDocument.p95Ms } : undefined }, null, 2));
  return report;
}

async function captureValidation(directory) {
  const evidenceDir = path.join(directory, 'validation');
  await mkdir(evidenceDir, { recursive: true });
  const testFiles = (await readdir(path.join(root, 'tests'))).filter(filename => filename.endsWith('.test.js')).sort().map(filename => path.join('tests', filename));
  const begin = performance.now();
  const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000 });
  const tap = `${tests.stdout || ''}${tests.stderr || ''}`;
  await writeFile(path.join(evidenceDir, 'node-tests.tap'), tap);
  const summary = { capturedAt: new Date().toISOString(), exitCode: tests.status, wallMs: round(performance.now() - begin), files: testFiles, tests: Number(tap.match(/^# tests (\d+)/m)?.[1] || 0), passed: Number(tap.match(/^# pass (\d+)/m)?.[1] || 0), failed: Number(tap.match(/^# fail (\d+)/m)?.[1] || 0), skipped: Number(tap.match(/^# skipped (\d+)/m)?.[1] || 0) };
  await writeFile(path.join(evidenceDir, 'test-summary.json'), JSON.stringify(summary, null, 2));
  if (tests.status !== 0 || summary.failed || !summary.tests) throw new Error(`Stage 5 test suite failed; inspect ${path.join(evidenceDir, 'node-tests.tap')}.`);
  const browserRun = spawnSync(process.execPath, [path.join(root, 'scripts', 'browser-test.js')], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000 });
  await writeFile(path.join(evidenceDir, 'browser-run.log'), `${browserRun.stdout || ''}${browserRun.stderr || ''}`);
  if (browserRun.status !== 0) throw new Error(`Stage 5 browser suite failed; inspect ${path.join(evidenceDir, 'browser-run.log')}.`);
  const browser = JSON.parse(await readFile(path.join(artifactRoot, 'browser', 'report.json'), 'utf8'));
  if (!browser.passed) throw new Error('Stage 5 requires a passing actual browser report.');
  await writeFile(path.join(evidenceDir, 'browser-report.json'), JSON.stringify(browser, null, 2));
  const distribution = JSON.parse(await readFile(path.join(root, 'dist', 'build-report.json'), 'utf8'));
  const checksums = await readFile(path.join(root, 'dist', 'SHA256SUMS'), 'utf8');
  if (!distribution.smokeTests?.length || !distribution.files?.length) throw new Error('Stage 5 requires distribution smoke results and checksums.');
  if (distribution.smokeTests.some(smoke => smoke.passed !== true || smoke.noNodeModules !== true || smoke.worker?.passed !== true)) throw new Error('Stage 5 requires passing isolated compiler and worker smoke tests without node_modules.');
  const productionFiles = [];
  const visitSource = async relative => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) await visitSource(filename);
      else if (entry.isFile()) {
        const content = await readFile(path.join(root, filename));
        productionFiles.push({ path: filename.split(path.sep).join('/'), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      } else throw new Error(`Unexpected non-file production source: ${filename}`);
    }
  };
  for (const folder of ['src', 'bin', 'web', 'assets', 'examples', 'docs']) await visitSource(folder);
  for (const filename of ['scripts/build.js', 'package.json', 'package-lock.json', 'LICENSE']) {
    const content = await readFile(path.join(root, filename));
    productionFiles.push({ path: filename, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  productionFiles.sort((left, right) => left.path.localeCompare(right.path));
  const productionHash = createHash('sha256').update(JSON.stringify(productionFiles)).digest('hex');
  if (!distribution.sources?.sha256 || productionHash !== distribution.sources.sha256) throw new Error('Distribution source fingerprint differs from current production files; rebuild before stage 5.');
  for (const file of distribution.files) {
    const content = await readFile(path.join(root, 'dist', file.filename));
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== file.sha256 || !checksums.includes(`${actual}  ${file.filename}`)) throw new Error(`Distribution checksum mismatch: ${file.filename}`);
  }
  await Promise.all([
    writeFile(path.join(evidenceDir, 'build-report.json'), JSON.stringify(distribution, null, 2)),
    writeFile(path.join(evidenceDir, 'SHA256SUMS'), checksums),
  ]);
  const supplemental = {};
  for (const [name, filename] of [['comparison', 'comparison/report.json'], ['reproducibility', 'reproducibility/report.json']]) {
    try {
      const evidence = JSON.parse(await readFile(path.join(artifactRoot, filename), 'utf8'));
      await writeFile(path.join(evidenceDir, `${name}-report.json`), JSON.stringify(evidence, null, 2));
      supplemental[name] = { report: `validation/${name}-report.json`, visualReport: `../../${name}/index.html`, capturedAt: evidence.capturedAt, passed: evidence.passed, caveats: evidence.caveats };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { tests: summary, browser: { passed: browser.passed, checks: browser.checks.length, browser: browser.browser, capturedAt: browser.capturedAt, report: 'validation/browser-report.json', visualReport: '../../browser/index.html' }, distribution: { buildMs: distribution.buildMs, files: distribution.files, sourceSha256: productionHash, sourceMatchesCurrent: true, smokeTests: distribution.smokeTests, report: 'validation/build-report.json', checksums: 'validation/SHA256SUMS' }, ...supplemental, limits: ['No PDF/UA conformance claim.', 'Complete paragraph bidirectional layout and all writing systems are not verified.', 'Raster comparisons cover bundled fixtures, not arbitrary documents.', 'Distributed runtime is platform-specific; see reproducibility evidence for independently checked compiler targets.'] };
}

async function benchmarkLongDocument(createCompiler, iterations) {
  const compiler = createCompiler({ rootDir: root });
  const source = longDocumentSource();
  const filename = path.join(root, 'benchmark-20-pages.ex');
  const initial = await compiler.compile(source, { filename, pdf: false });
  if (initial.layout.pages.length !== 20) throw new Error(`Expected 20-page benchmark; got ${initial.layout.pages.length}.`);
  const samples = [];
  let last;
  for (let revision = 0; revision < iterations; revision++) {
    const edited = source.replace('ORIGINAL', `EDITED-${revision}`);
    const begin = performance.now();
    last = await compiler.compile(edited, { filename, pdf: false });
    samples.push({ revision, wallMs: round(performance.now() - begin), ...last.stats });
  }
  const fresh = await createCompiler({ rootDir: root }).compile(source.replace('ORIGINAL', `EDITED-${iterations - 1}`), { filename, pdf: false });
  const normalize = layout => JSON.stringify(layout.pages.map(page => ({ width: page.width, height: page.height, items: page.items })));
  const freshMatchesCached = normalize(fresh.layout) === normalize(last.layout);
  if (!freshMatchesCached) throw new Error('Incremental layout differs from a fresh compile of the same edited source.');
  return { pages: initial.layout.pages.length, sourceBytes: Buffer.byteLength(source), iterations, p50Ms: round(percentile(samples.map(sample => sample.wallMs), .5)), p95Ms: round(percentile(samples.map(sample => sample.wallMs), .95)), initial: initial.stats, samples, freshMatchesCached, scope: '20 explicit pages; edit first paragraph; preview HTML output, no PDF export. Full parsing and page traversal may still occur.' };
}

const style = `:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172238;background:#f3f5f8}*{box-sizing:border-box}body{margin:0}main{max-width:1420px;margin:auto;padding:38px 28px}h1{font-size:34px;letter-spacing:-1px;margin:8px 0 14px}p{line-height:1.65;color:#4c5a70}a{color:#175aca}table{border-collapse:collapse;width:100%;background:white;margin:20px 0}th,td{text-align:left;padding:15px;border-bottom:1px solid #e1e5eb}th{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#637086}small{color:#627089}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.panel{background:#fff;border:1px solid #dce2ea;border-radius:12px;overflow:hidden}.panel h2{font-size:15px;margin:0;padding:16px;border-bottom:1px solid #e0e5ed}iframe{display:block;width:100%;height:720px;border:0;background:white}.links{display:flex;flex-wrap:wrap;gap:14px;margin:22px 0}.badge{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#257351;font-weight:700}pre{white-space:pre-wrap;word-break:break-word;padding:18px;background:#e8edf4;border-radius:8px}.metrics{display:flex;flex-wrap:wrap;gap:12px}.metric{background:white;border:1px solid #dce2ea;padding:16px 20px;border-radius:10px}.metric strong{display:block;font-size:25px;margin-bottom:5px}@media(max-width:900px){.grid{grid-template-columns:1fr}iframe{height:580px}main{padding:24px 16px}table{font-size:13px}th,td{padding:10px}}`;

function captureHtml(report) {
  const json = JSON.stringify({ compile: report.compile, warmEdit: { p50Ms: report.warmEdit.p50Ms, p95Ms: report.warmEdit.p95Ms, iterations: report.warmEdit.iterations }, coldCli: report.coldCli, longDocument: report.longDocument && { pages: report.longDocument.pages, p50Ms: report.longDocument.p50Ms, p95Ms: report.longDocument.p95Ms, freshMatchesCached: report.longDocument.freshMatchesCached }, environment: report.environment, diagnostics: report.diagnostics, validation: report.validation }, null, 2);
  const evidence = report.validation ? `<section class="panel" style="padding:20px;margin:24px 0"><h2>Stage 5 acceptance evidence</h2><p>${report.validation.tests.passed} / ${report.validation.tests.tests} automated tests passed. ${report.validation.browser.checks} actual browser checks passed in Chromium ${escape(report.validation.browser.browser)}.</p><div class="links"><a href="validation/node-tests.tap">Full test output</a><a href="validation/test-summary.json">Test summary</a><a href="${report.validation.browser.visualReport}">Browser views and raster comparisons</a><a href="validation/browser-report.json">Captured browser evidence</a><a href="validation/build-report.json">Distribution smoke tests</a><a href="validation/SHA256SUMS">Verified archive checksums</a>${report.validation.comparison ? `<a href="${report.validation.comparison.visualReport}">External baseline and caveats</a><a href="${report.validation.comparison.report}">Captured baseline evidence</a>` : ''}${report.validation.reproducibility ? `<a href="${report.validation.reproducibility.visualReport}">Cross-platform reproducibility</a><a href="${report.validation.reproducibility.report}">Captured reproducibility evidence</a>` : ''}</div><p>${report.validation.limits.map(escape).join(' ')}</p></section>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Earlyx · Stage ${report.stage}</title><style>${style}</style><main><a href="../../index.html">← All stage reports</a><p class="badge">Measured stage ${report.stage}</p><h1>${escape(report.name)}</h1><p>${escape(report.description)}</p><div class="metrics"><div class="metric"><strong>${report.compile.wallMs} ms</strong>First full export</div><div class="metric"><strong>${report.warmEdit.p95Ms} ms</strong>Warm preview edit p95</div><div class="metric"><strong>${report.output.pages}</strong>Pages</div>${report.coldCli ? `<div class="metric"><strong>${report.coldCli.wallMs} ms</strong>Cold CLI process</div>` : ''}</div><div class="links"><a href="document.pdf">Download PDF</a><a href="document.html">Paged HTML</a><a href="document.web.html">Responsive HTML</a><a href="${escape(report.sourceSnapshot.entry)}">Source</a><a href="source.tar.gz">Source + dependencies</a><a href="report.json">All measurements</a><a href="document.layout.json">Shared layout</a></div>${evidence}<div class="grid"><section class="panel"><h2>Paged HTML · shared layout</h2><iframe title="Paged HTML output" src="document.html"></iframe></section><section class="panel"><h2>Responsive HTML · reflow allowed</h2><iframe title="Responsive HTML output" src="document.web.html"></iframe></section><section class="panel"><h2>PDF · same positioned pages</h2><iframe title="PDF output" src="document.pdf"></iframe></section></div><p><small>Captured ${escape(new Date(report.capturedAt).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }))} KST. ${escape(report.note)} Warm preview timings exclude PDF generation. Cold CLI timing includes process startup and all exports.</small></p><pre>${escape(json)}</pre></main></html>`;
}

async function regenerateIndex() {
  const reports = [];
  for (const stage of stageDefinitions) {
    try { reports.push(JSON.parse(await readFile(path.join(artifactRoot, `stage-${stage.number}`, 'latest.json'), 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path.join(artifactRoot, 'stages.json'), JSON.stringify(reports.map(({ pdfInspection, ...report }) => report), null, 2));
  const rows = stageDefinitions.map(stage => {
    const report = reports.find(item => item.stage === stage.number);
    return `<tr><td>${stage.number}</td><td>${report ? `<a href="${report.relativeDir}/index.html">${escape(stage.name)}</a>` : escape(stage.name)}</td><td>${report ? `${report.compile.wallMs} ms` : 'Pending capture'}</td><td>${report ? `${report.warmEdit.p95Ms} ms` : '—'}</td><td>${report?.output.pages ?? '—'}</td><td>${report ? `<a href="${report.relativeDir}/document.html">HTML</a> · <a href="${report.relativeDir}/document.web.html">Web</a> · <a href="${report.relativeDir}/document.pdf">PDF</a>` : '—'}</td></tr>`;
  }).join('');
  const latest = reports.at(-1);
  await writeFile(path.join(artifactRoot, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Earlyx · Measured milestones</title><style>${style}</style><main><p class="badge">Earlyx / engineering notebook</p><h1>One source. Measured results.</h1><p>Actual stage captures with downloadable source, matching paged HTML and PDF, responsive web output, and timing samples. Follow a stage to compare the views side by side.</p><table><thead><tr><th>Stage</th><th>Verified scope</th><th>First export</th><th>Warm edit p95</th><th>Pages</th><th>Views</th></tr></thead><tbody>${rows}</tbody></table><p>First export measures compilation and all output generation after module loading. Warm preview edits use a reused compiler and exclude PDF generation. Individual reports also record cold CLI process time. Stage numbers describe fixture scope; every capture is timestamped and retained.</p>${latest?.longDocument ? `<div class="metrics"><div class="metric"><strong>${latest.longDocument.pages} pages</strong>Long-document fixture</div><div class="metric"><strong>${latest.longDocument.p50Ms} ms</strong>Preview edit p50</div><div class="metric"><strong>${latest.longDocument.p95Ms} ms</strong>Preview edit p95</div></div>` : ''}<p><a href="stages.json">Machine-readable measurements</a> · <a href="browser/index.html">Browser verification</a> · <a href="comparison/index.html">External baseline</a> · <a href="reproducibility/index.html">Cross-platform reproducibility</a> · <a href="/">Open live editor</a></p><p><small>These measurements describe this machine and these fixtures. They are not a guarantee for arbitrary documents or a comparison with a separately configured LaTeX/Typst installation. Accessibility and complete writing-system coverage require additional assessment.</small></p></main></html>`);
}

async function main() {
  const args = process.argv.slice(2);
  const selected = args.includes('--all') ? stageDefinitions.map(stage => stage.number) : [Number(args[args.indexOf('--stage') + 1] || 1)];
  const iterationIndex = args.indexOf('--iterations');
  const iterations = iterationIndex >= 0 ? Number(args[iterationIndex + 1]) : 20;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200) throw new Error('--iterations must be between 1 and 200.');
  for (const number of selected) {
    const definition = stageDefinitions.find(stage => stage.number === number);
    if (!definition) throw new Error('--stage must be 1 through 5.');
    await captureStage(definition, { iterations, skipCold: args.includes('--skip-cold') });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
