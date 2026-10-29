#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { longDocumentSource } from './stages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'dist', 'earlyx-node');
const outputRoot = path.join(root, 'artifacts', 'reproducibility');
const image = process.env.EARLYX_LINUX_IMAGE || 'node:24-alpine';
const tolerance = 1e-6;
const hash = value => createHash('sha256').update(value).digest('hex');
const round = number => Math.round(number * 100) / 100;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function run(executable, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000, ...options });
  if (result.error || result.status !== 0) {
    const error = new Error(`${executable} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), wallMs: round(performance.now() - started) };
}

function normalized(value, projectRoot) {
  if (Array.isArray(value)) return value.map(item => normalized(item, projectRoot));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, key === 'file' && typeof value[key] === 'string' ? normalizedFilename(value[key], projectRoot) : normalized(value[key], projectRoot)]));
  return value;
}

function normalizedFilename(filename, projectRoot) {
  const prefix = `${projectRoot.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  const name = filename.replace(/\\/g, '/');
  return name.startsWith(prefix) ? `PROJECT/${name.slice(prefix.length)}` : name;
}

function compareGeometry(left, right) {
  const differences = [];
  let differenceCount = 0, maximumNumericDelta = 0, numericFields = 0;
  const record = (pointer, a, b) => { differenceCount++; if (differences.length < 25) differences.push({ pointer, host: a, linux: b }); };
  function visit(a, b, pointer = '') {
    if (typeof a === 'number' && typeof b === 'number') {
      const delta = Math.abs(a - b);
      numericFields++;
      maximumNumericDelta = Math.max(maximumNumericDelta, delta);
      if (!Number.isFinite(delta) || delta > tolerance) record(pointer, a, b);
      return;
    }
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) record(`${pointer}/length`, a.length, b.length);
      for (let index = 0; index < Math.min(a.length, b.length); index++) visit(a[index], b[index], `${pointer}/${index}`);
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) record(`${pointer}/${key}`, a[key] ?? '<missing>', b[key] ?? '<missing>');
        else visit(a[key], b[key], `${pointer}/${key}`);
      }
      return;
    }
    record(pointer, a, b);
  }
  visit(left, right);
  return { equal: differenceCount === 0, numericTolerance: tolerance, numericFields, maximumNumericDelta, differenceCount, differences };
}

async function treeFingerprint(directory) {
  const files = [];
  async function visit(relative = '') {
    const absolute = path.join(directory, relative);
    for (const entry of (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Reproducibility bundle cannot contain symlinks: ${next}`);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(directory, next));
        files.push({ path: next.split(path.sep).join('/'), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await visit();
  return { sha256: hash(JSON.stringify(files)), files };
}

async function validateBuild() {
  const build = JSON.parse(await fs.readFile(path.join(root, 'dist', 'build-report.json'), 'utf8'));
  if (!build.sources?.files?.length) throw new Error('The distribution has no source manifest. Run npm run build first.');
  for (const entry of build.sources.files) {
    if (hash(await fs.readFile(path.join(root, entry.path))) !== entry.sha256) throw new Error(`Build is stale: ${entry.path} changed. Rebuild before measuring reproducibility.`);
  }
  try { await fs.access(path.join(bundle, 'node_modules')); throw new Error('The offline bundle unexpectedly contains node_modules.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const info = JSON.parse(await fs.readFile(path.join(bundle, 'BUILD.json'), 'utf8'));
  const bundleSha256 = hash(await fs.readFile(path.join(bundle, 'bin', 'earlyx.js')));
  if (info.bundleSha256 !== bundleSha256) throw new Error('Bundled CLI hash does not match BUILD.json.');
  return { sourceSha256: build.sources.sha256, bundleSha256, version: info.version, builtAt: info.builtAt, inventory: await treeFingerprint(bundle) };
}

const containerArguments = [
  'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '2g',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
];

async function inspectOutputs(directory, basename, projectRoot) {
  const layout = normalized(JSON.parse(await fs.readFile(path.join(directory, `${basename}.layout.json`), 'utf8')), projectRoot);
  const pdf = await fs.readFile(path.join(directory, `${basename}.pdf`));
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${basename} did not produce a PDF.`);
  const timings = JSON.parse(await fs.readFile(path.join(directory, `${basename}.timings.json`), 'utf8'));
  if (timings.diagnostics?.some(message => message.severity === 'error')) throw new Error(`${basename} has compilation errors: ${JSON.stringify(timings.diagnostics)}`);
  const normalizeHTML = text => text.replaceAll(`${projectRoot}/`, 'PROJECT/');
  const html = normalizeHTML(await fs.readFile(path.join(directory, `${basename}.html`), 'utf8'));
  const webHtml = normalizeHTML(await fs.readFile(path.join(directory, `${basename}.web.html`), 'utf8'));
  return { layout, pdfSha256: hash(pdf), pdfBytes: pdf.length, layoutSha256: hash(JSON.stringify(layout)), pagedHtmlSha256: hash(html), responsiveHtmlSha256: hash(webHtml), pages: layout.pages.length, compileMs: round(timings.totalMs), diagnostics: timings.diagnostics || [] };
}

function reportHTML(report) {
  const rows = report.fixtures.map(fixture => {
    const links = platform => ['html', 'web.html', 'pdf', 'layout.json'].map(extension => `<a href="${platform}/${fixture.name}/${fixture.name}.${extension}">${extension === 'html' ? 'Paged' : extension === 'web.html' ? 'Web' : extension === 'pdf' ? 'PDF' : 'Layout'}</a>`).join(' · ');
    return `<tr><th><a href="fixtures/${fixture.name}.ex">${escape(fixture.name)}</a></th><td>${fixture.host.pages}</td><td>${fixture.geometry.equal ? 'Match' : 'DIFFERENT'}</td><td>${fixture.pdfBytesEqual ? 'Identical' : 'Different'}</td><td>${fixture.host.compileMs} ms / ${fixture.linux.compileMs} ms</td><td>${links('host')}</td><td>${links('linux')}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Earlyx · macOS and Linux reproducibility</title><style>body{margin:0;background:#f4f5f1;color:#20313a;font:15px/1.6 system-ui}main{max-width:1200px;padding:52px 28px;margin:auto}h1{font-size:36px;letter-spacing:-1px;line-height:1.2}p{max-width:920px}a{color:#276179;text-underline-offset:3px}table{border-collapse:collapse;width:100%;font-size:13px;background:white}th,td{padding:14px 10px;border-bottom:1px solid #d7dfdf;text-align:left;vertical-align:top}thead{background:#e4eceb}.badge{display:inline-block;padding:5px 10px;border-radius:5px;background:${report.checks.geometryPassed ? '#d7eddf' : '#f4d9d9'};font-size:12px}.overflow{overflow:auto}code{font-size:12px;overflow-wrap:anywhere}small{color:#60707b}</style><main><p class="badge">Actual ${escape(report.host.platform)} / Linux execution · ${report.checks.geometryPassed ? 'Geometry matched' : 'Differences found'}</p><h1>One bundle. Two operating systems.</h1><p>The same dependency-bundled CLI compiled five fixtures on the native host and inside an official Node Linux container. Container networking was disabled, its root filesystem and compiler bundle were read-only, and neither environment used a project node_modules directory.</p><p><strong>Geometry:</strong> ${report.checks.geometryPassed ? 'All fixtures match' : 'At least one fixture differs'} at an absolute numeric tolerance of ${tolerance} points. <strong>PDF bytes:</strong> ${report.checks.pdfBytesIdentical ? 'Identical for every fixture.' : 'At least one file differs; inspect report.json for hashes.'} <strong>Normalized HTML:</strong> ${report.checks.htmlIdentical ? 'Identical for every fixture.' : 'At least one file differs.'}</p><div class="overflow"><table><thead><tr><th>Fixture</th><th>Pages</th><th>Geometry</th><th>PDF bytes</th><th>Engine host / Linux</th><th>Host output</th><th>Linux output</th></tr></thead><tbody>${rows}</tbody></table></div><p><a href="report.json">Full measurements and differences</a> · <a href="fixtures/long-document.ex">20-page source</a> · <a href="../index.html">Stage reports</a></p><p><small>Only absolute source filenames are normalized. Every page/item field is compared; differences are reported rather than discarded. Process wall times include startup and, on Linux, container launch and shared-volume overhead; the table shows compiler-reported engine time. These checks do not establish Windows compatibility, pixel identity across viewers, or correctness for arbitrary documents.</small></p><p><small>Host: ${escape(report.host.node)} · ${escape(report.host.platform)}/${escape(report.host.arch)}. Linux: ${escape(report.linux.node)} · ${escape(report.linux.platform)}/${escape(report.linux.arch)}. Image: <code>${escape(report.container.repositoryDigests.join(', ') || report.container.imageId)}</code></small></p><p><small>Bundle SHA-256: <code>${report.build.bundleSha256}</code></small></p></main></html>`;
}

async function main() {
  const started = performance.now();
  if (process.platform !== 'darwin') throw new Error('This recipe requires a macOS native host so the comparison actually covers macOS and Linux.');
  const build = await validateBuild();
  const inspection = JSON.parse(run('docker', ['image', 'inspect', image]).stdout)[0];
  const dockerVersion = run('docker', ['version', '--format', '{{.Server.Version}}']).stdout;
  const linux = JSON.parse(run('docker', [...containerArguments, image, 'node', '-p', 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,icu:process.versions.icu,zlib:process.versions.zlib})']).stdout);
  if (linux.platform !== 'linux') throw new Error('The comparison container did not report Linux.');
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-reproducibility-')));
  const project = path.join(temporary, 'project');
  const fixtures = ['minimal', 'article', 'showcase', 'multilingual', 'long-document'];
  try {
    await fs.mkdir(project, { recursive: true });
    await fs.cp(path.join(bundle, 'examples'), path.join(project, 'examples'), { recursive: true });
    await fs.writeFile(path.join(project, 'examples', 'long-document.ex'), longDocumentSource(20));
    const records = [];
    const hostEnvironment = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' };
    for (const name of fixtures) {
      const host = run(process.execPath, [path.join(bundle, 'bin', 'earlyx.js'), 'compile', `examples/${name}.ex`, '--root', project, '--out', `host/${name}`], { cwd: project, env: hostEnvironment });
      const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
      const linuxRun = run('docker', [...containerArguments, ...user, '--env', 'HOME=/tmp', '--env', 'NODE_PATH=', '--env', 'NODE_OPTIONS=', '--mount', `type=bind,source=${bundle},target=/opt/earlyx,readonly`, '--mount', `type=bind,source=${project},target=/work`, '--workdir', '/work', image, 'node', '/opt/earlyx/bin/earlyx.js', 'compile', `examples/${name}.ex`, '--root', '/work', '--out', `linux/${name}`]);
      const hostOutput = await inspectOutputs(path.join(project, 'host', name), name, project);
      const linuxOutput = await inspectOutputs(path.join(project, 'linux', name), name, '/work');
      const geometry = compareGeometry(hostOutput.layout, linuxOutput.layout);
      if (name === 'long-document' && (hostOutput.pages !== 20 || linuxOutput.pages !== 20)) throw new Error('The long-document fixture must contain exactly 20 pages.');
      const { layout: hostLayout, ...hostFields } = hostOutput;
      const { layout: linuxLayout, ...linuxFields } = linuxOutput;
      records.push({ name, geometry, pdfBytesEqual: hostOutput.pdfSha256 === linuxOutput.pdfSha256, pagedHtmlEqual: hostOutput.pagedHtmlSha256 === linuxOutput.pagedHtmlSha256, responsiveHtmlEqual: hostOutput.responsiveHtmlSha256 === linuxOutput.responsiveHtmlSha256, host: { ...hostFields, processWallMs: host.wallMs, stdout: host.stdout }, linux: { ...linuxFields, containerWallMs: linuxRun.wallMs, stdout: linuxRun.stdout } });
      console.log(`${name}: ${hostOutput.pages} pages; geometry ${geometry.equal ? 'MATCH' : 'DIFFERENT'}; PDF ${hostOutput.pdfSha256 === linuxOutput.pdfSha256 ? 'byte-identical' : 'bytes differ'}; engine ${hostOutput.compileMs} ms host / ${linuxOutput.compileMs} ms Linux`);
    }
    await fs.mkdir(outputRoot, { recursive: true });
    for (const name of ['host', 'linux']) { await fs.rm(path.join(outputRoot, name), { recursive: true, force: true }); await fs.cp(path.join(project, name), path.join(outputRoot, name), { recursive: true }); }
    await fs.rm(path.join(outputRoot, 'fixtures'), { recursive: true, force: true });
    await fs.cp(path.join(project, 'examples'), path.join(outputRoot, 'fixtures'), { recursive: true });
    const report = {
      capturedAt: new Date().toISOString(), elapsedMs: round(performance.now() - started),
      checks: { geometryPassed: records.every(record => record.geometry.equal), pdfBytesIdentical: records.every(record => record.pdfBytesEqual), htmlIdentical: records.every(record => record.pagedHtmlEqual && record.responsiveHtmlEqual) },
      host: { node: process.version, platform: process.platform, arch: process.arch, icu: process.versions.icu, zlib: process.versions.zlib }, linux,
      container: { image, imageId: inspection.Id, repositoryDigests: inspection.RepoDigests || [], dockerVersion, network: 'none', rootFilesystem: 'read-only', bundleMount: 'read-only', pull: 'never' },
      build, recipe: { sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), generatorSha256: hash(await fs.readFile(new URL('./stages.js', import.meta.url))) },
      normalization: 'Absolute source.file paths are replaced by PROJECT/relative/path. All other fields remain intact.', numericTolerance: tolerance,
      timingScope: { compileMs: 'Compiler-reported parse + layout + HTML + PDF generation; excludes module loading and process startup.', hostWallMs: 'Native process startup, compilation and output writes.', linuxWallMs: 'Container startup, process startup, compilation and shared-volume output writes.' },
      fixtures: records,
    };
    await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(outputRoot, 'index.html'), reportHTML(report));
    console.log(`Report: ${path.join(outputRoot, 'index.html')}`);
    if (!report.checks.geometryPassed || !report.checks.htmlIdentical) process.exitCode = 1;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
