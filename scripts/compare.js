#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { longDocumentSource, inspectPdf, percentile } from './stages.js';
import { createCompiler } from '../src/compiler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'artifacts', 'comparison');
const typst = process.argv[process.argv.indexOf('--typst') + 1];
if (!process.argv.includes('--typst') || !typst) throw new Error('Usage: node scripts/compare.js --typst /path/to/typst');
await fs.mkdir(out, { recursive: true });
const ex = longDocumentSource(20);
const typ = '#set page(paper: "a4", margin: 48pt)\n#set text(font: "Source Serif 4", size: 11pt)\n#set par(leading: 4.95pt)\n#align(center, text(size: 29pt, weight: "bold")[Twenty-page edit benchmark])\n\n' + Array.from({ length: 20 }, (_, i) => `= Section ${i + 1}\n\n` + Array.from({ length: 6 }, (__, p) => `Paragraph ${p + 1} on section ${i + 1}. This benchmark uses stable paragraphs with enough text to exercise line breaking and source mapping. The compiler should reuse unchanged paragraph layouts while still calculating correct page positions. Edit marker: ORIGINAL.`).join('\n\n') + (i < 19 ? '\n\n#pagebreak()\n\n' : '\n')).join('');
await fs.writeFile(path.join(out, 'twenty-pages.ex'), ex);
await fs.writeFile(path.join(out, 'twenty-pages.typ'), typ);
const executions = [
  { name: 'Earlyx CLI: PDF + both HTML modes + layout/timings JSON', executable: process.execPath, args: ['bin/earlyx.js', 'compile', 'artifacts/comparison/twenty-pages.ex', '--out', 'artifacts/comparison/earlyx'] },
  { name: 'Typst CLI: PDF only', executable: typst, args: ['compile', '--ignore-system-fonts', '--font-path', 'assets/fonts', 'artifacts/comparison/twenty-pages.typ', 'artifacts/comparison/typst.pdf'] },
];
for (const execution of executions) {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const child = spawnSync(execution.executable, execution.args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Compiler exited unsuccessfully');
    if (i >= 2) samples.push(performance.now() - start);
  }
  execution.samplesMs = samples;
  execution.p50Ms = percentile(samples, 0.5);
  execution.p95Ms = percentile(samples, 0.95);
}
const compiler = createCompiler({ rootDir: root });
const compiled = await compiler.compile(ex, { filename: 'artifacts/comparison/twenty-pages.ex' });
const pdfInfo = await inspectPdf(await fs.readFile(path.join(out, 'typst.pdf')), { pages: compiled.layout.pages.map(page => ({ ...page, items: [] })) });
const version = spawnSync(typst, ['--version'], { encoding: 'utf8' }).stdout.trim();
const report = { capturedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model }, typstVersion: version, pages: { earlyx: compiled.layout.pages.length, typst: pdfInfo.pages },
  caveats: ['This is an informational cold-process baseline, not a matched-output performance ranking.', 'Both fixtures contain the same twenty explicit sections and paragraph content, but typography and heading styles differ.', 'Earlyx emits PDF, both HTML modes, layout JSON, and timings JSON; Typst emits PDF only.', 'Two warmup invocations are excluded; eight fresh-process invocations are recorded for each compiler.', 'Filesystem caches may be warm. No comparison of incremental Typst watch latency is attempted.'], executions };
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const rows = executions.map(x => `<tr><td>${x.name}</td><td>${x.p50Ms.toFixed(1)} ms</td><td>${x.p95Ms.toFixed(1)} ms</td></tr>`).join('');
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Earlyx · Existing compiler baseline</title><style>body{max-width:900px;margin:60px auto;padding:20px;font:17px/1.6 system-ui;color:#23313b}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #ccd7dc;padding:12px}a{color:#225b72}</style><h1>Existing compiler baseline</h1><p>Actual measurements against ${version}; 20 explicit pages on ${report.environment.cpu}.</p><table><tr><th>Invocation</th><th>Median</th><th>p95</th></tr>${rows}</table><ul>${report.caveats.map(x => `<li>${x}</li>`).join('')}</ul><p><a href="report.json">Raw results</a> · <a href="twenty-pages.ex">Earlyx source</a> · <a href="twenty-pages.typ">Typst source</a> · <a href="earlyx/twenty-pages.pdf">Earlyx PDF</a> · <a href="typst.pdf">Typst PDF</a> · <a href="../index.html">Stage dashboard</a></p></html>`);
console.log(JSON.stringify({ ...report, executions: executions.map(({ samplesMs, ...x }) => x) }, null, 2));
