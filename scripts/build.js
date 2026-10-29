import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist');
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async filename => { try { await fs.access(filename); return true; } catch { return false; } };
const elapsed = start => Math.round((performance.now() - start) * 100) / 100;

async function copyIfPresent(from, to) {
  if (await exists(from)) await fs.cp(from, to, { recursive: true });
}

async function sourceFingerprint() {
  const files = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      const data = await fs.readFile(absolute);
      files.push({ path: relative.split(path.sep).join('/'), bytes: data.length, sha256: hash(data) });
    } else throw new Error(`Distribution source must be an ordinary file or directory: ${relative}`);
  }
  for (const relative of ['src', 'bin', 'web', 'assets', 'examples', 'docs', 'scripts/build.js', 'package.json', 'package-lock.json', 'LICENSE']) await visit(relative);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: hash(JSON.stringify(files)), files };
}

async function packageLicenses(inputs, target) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes('node_modules/')) continue;
    let current = path.dirname(path.resolve(root, input));
    while (current.startsWith(path.join(root, 'node_modules'))) {
      const manifestPath = path.join(current, 'package.json');
      if (await exists(manifestPath)) {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (manifest.name && manifest.version) packages.set(current, manifest);
        break;
      }
      current = path.dirname(current);
    }
  }
  const notices = ['Earlyx bundled third-party software', '', 'Font licenses are also retained beside the fonts in assets/fonts.', ''];
  const inventory = [];
  for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const licenseName = `${manifest.name.replace(/[^\w.-]/g, '_')}-${manifest.version}`;
    const files = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^(?:license|licence|copying|notice)(?:[._-]|$)/i.test(entry.name));
    const licenseDir = path.join(target, 'LICENSES', licenseName);
    await fs.mkdir(licenseDir, { recursive: true });
    for (const file of files) await fs.copyFile(path.join(directory, file.name), path.join(licenseDir, file.name));
    const item = { name: manifest.name, version: manifest.version, license: manifest.license || 'See package notices', files: files.map(file => `LICENSES/${licenseName}/${file.name}`) };
    inventory.push(item);
    notices.push(`${item.name} ${item.version} — ${typeof item.license === 'string' ? item.license : JSON.stringify(item.license)}`, ...item.files, '');
  }
  await fs.writeFile(path.join(target, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
  return inventory;
}

async function copyStageReports(target) {
  for (let number = 1; number <= 5; number++) {
    const source = path.join(root, 'artifacts', `stage-${number}`);
    await copyIfPresent(source, path.join(target, 'artifacts', `stage-${number}`));
  }
  for (const name of ['index.html', 'stages.json']) await copyIfPresent(path.join(root, 'artifacts', name), path.join(target, 'artifacts', name));
  for (const name of ['browser', 'comparison']) {
    const source = path.join(root, 'artifacts', name);
    if (await exists(source)) await fs.cp(source, path.join(target, 'artifacts', name), { recursive: true, filter: filename => path.basename(filename) !== 'failure.json' });
  }
}

async function smokeTest(distribution, bundledRuntime) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-offline-smoke-')));
  const started = performance.now();
  try {
    const isolated = path.join(temporary, 'earlyx');
    await fs.cp(distribution, isolated, { recursive: true });
    const executable = bundledRuntime ? path.join(isolated, 'earlyx') : process.execPath;
    const cli = path.join(isolated, 'bin', 'earlyx.js');
    const cliArguments = bundledRuntime ? [] : [cli];
    const environment = { PATH: '/usr/bin:/bin', HOME: temporary, NODE_PATH: '', NODE_OPTIONS: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
    const options = { cwd: isolated, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 };
    const help = execFileSync(executable, [...cliArguments, '--help'], options);
    if (!help.includes('earlyx compile')) throw new Error('Packaged CLI help failed.');
    const version = execFileSync(executable, [...cliArguments, '--version'], options).trim();
    const output = execFileSync(executable, [...cliArguments, 'compile', 'examples/showcase.ex', '--out', 'smoke-output'], options);
    const pdf = await fs.readFile(path.join(isolated, 'smoke-output', 'showcase.pdf'));
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Packaged CLI did not produce a PDF.');
    for (const filename of ['showcase.html', 'showcase.web.html', 'showcase.layout.json', 'showcase.timings.json']) {
      if (!(await fs.stat(path.join(isolated, 'smoke-output', filename))).size) throw new Error(`Missing packaged output ${filename}.`);
    }
    const timings = JSON.parse(await fs.readFile(path.join(isolated, 'smoke-output', 'showcase.timings.json'), 'utf8'));
    if (timings.diagnostics?.some(diagnostic => diagnostic.severity === 'error')) throw new Error('Packaged showcase has compiler errors.');
    const child = spawn(executable, [...cliArguments, 'serve', '--port', '0'], { cwd: isolated, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverOutput = '';
    const stopped = new Promise(resolve => child.once('exit', resolve));
    let workerCheck;
    try {
      const url = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Packaged server did not start: ${serverOutput}`)), 15_000);
        const inspect = data => { serverOutput += String(data); const match = serverOutput.match(/playground:\s*(http:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } };
        child.stdout.on('data', inspect); child.stderr.on('data', inspect);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Packaged server exited (${code}): ${serverOutput}`)); });
      });
      const response = await fetch(`${url}/api/compile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: '# Packaged worker\n\nThis preview runs in the packaged worker.', filename: 'worker-smoke.ex', revision: 1, pdf: false }),
        signal: AbortSignal.timeout(15_000),
      });
      const preview = await response.json();
      if (!response.ok || !preview.html?.includes('<svg') || !preview.pdfUrl) throw new Error(`Packaged worker compilation failed: ${JSON.stringify(preview).slice(0, 500)} ${serverOutput}`);
      const pdfResponse = await fetch(new URL(preview.pdfUrl, url), { signal: AbortSignal.timeout(15_000) });
      const lazyPdf = Buffer.from(await pdfResponse.arrayBuffer());
      if (!pdfResponse.ok || lazyPdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Packaged worker PDF export failed.');
      workerCheck = { passed: true, previewMs: preview.stats?.totalMs, lazyPdfBytes: lazyPdf.length };
    } finally {
      child.kill('SIGTERM');
      await Promise.race([stopped, new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref())]);
    }
    return { passed: true, runtime: bundledRuntime ? 'bundled' : 'host-node', node: process.version, platform: process.platform, arch: process.arch, version, wallMs: elapsed(started), compileMs: timings.totalMs, pages: timings.pages, pdfBytes: pdf.length, worker: workerCheck, noNodeModules: !(await exists(path.join(isolated, 'node_modules'))), output: output.trim() };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  const started = performance.now();
  const sourceManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const sources = await sourceFingerprint();
  await fs.mkdir(destination, { recursive: true });
  for (const filename of ['build-report.json', 'SHA256SUMS', `earlyx-${sourceManifest.version}-node.tar.gz`, `earlyx-${sourceManifest.version}-${process.platform}-${process.arch}.tar.gz`, `earlyx-${sourceManifest.version}.tgz`]) {
    await fs.rm(path.join(destination, filename), { force: true });
  }
  const nodeDir = path.join(destination, 'earlyx-node');
  const runtimeDir = path.join(destination, 'earlyx-runtime');
  for (const directory of [nodeDir, runtimeDir]) await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(path.join(nodeDir, 'bin'), { recursive: true });
  const bundleOptions = {
    absWorkingDir: root,
    bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'bundle', metafile: true,
    define: { PACKAGE_VERSION: JSON.stringify(JSON.parse(await fs.readFile(path.join(root, 'node_modules/mathjax-full/package.json'), 'utf8')).version) },
    banner: { js: 'import {createRequire as __earlyxCreateRequire} from "node:module"; import {fileURLToPath as __earlyxFileURLToPath} from "node:url"; import {dirname as __earlyxDirname} from "node:path"; const require=__earlyxCreateRequire(import.meta.url); const __filename=__earlyxFileURLToPath(import.meta.url); const __dirname=__earlyxDirname(__filename);' },
    logLevel: 'warning',
  };
  const result = await build({ ...bundleOptions, entryPoints: ['bin/earlyx.js'], outfile: path.join(nodeDir, 'bin', 'earlyx.js') });
  if (await exists(path.join(root, 'src', 'compile-worker.js'))) {
    const worker = await build({ ...bundleOptions, entryPoints: ['src/compile-worker.js'], outfile: path.join(nodeDir, 'bin', 'compile-worker.js') });
    Object.assign(result.metafile.inputs, worker.metafile.inputs);
  }
  await fs.chmod(path.join(nodeDir, 'bin', 'earlyx.js'), 0o755);
  for (const name of ['assets', 'examples', 'web', 'docs']) await copyIfPresent(path.join(root, name), path.join(nodeDir, name));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(nodeDir, 'LICENSE'));
  // PDFKit lazily loads its standard fonts through a package imports map and
  // resolves its color profile relative to the bundled file's __filename.
  await fs.mkdir(path.join(nodeDir, 'bin', 'standard-fonts'), { recursive: true });
  for (const entry of await fs.readdir(path.join(root, 'node_modules/pdfkit/js/standard-fonts'))) {
    if (entry.endsWith('.cjs')) await fs.copyFile(path.join(root, 'node_modules/pdfkit/js/standard-fonts', entry), path.join(nodeDir, 'bin', 'standard-fonts', entry));
  }
  await fs.cp(path.join(root, 'node_modules/pdfkit/js/standard-fonts/chunks'), path.join(nodeDir, 'bin', 'standard-fonts', 'chunks'), { recursive: true });
  await fs.cp(path.join(root, 'node_modules/pdfkit/js/data'), path.join(nodeDir, 'bin', 'data'), { recursive: true });
  const dependencies = await packageLicenses(result.metafile.inputs, nodeDir);
  const manifest = {
    name: 'earlyx', version: sourceManifest.version, description: sourceManifest.description, type: 'module',
    bin: { earlyx: './bin/earlyx.js' }, engines: { node: '>=22' }, license: 'MIT',
    imports: { '#standard-fonts/*': './bin/standard-fonts/*.cjs' },
    files: ['bin', 'assets', 'examples', 'web', 'docs', 'LICENSES', 'THIRD_PARTY_NOTICES.txt', 'BUILD.json', 'artifacts'],
  };
  await fs.writeFile(path.join(nodeDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyStageReports(nodeDir);
  const bundledCode = await fs.readFile(path.join(nodeDir, 'bin', 'earlyx.js'));
  const workerFile = path.join(nodeDir, 'bin', 'compile-worker.js');
  const workerCode = await exists(workerFile) ? await fs.readFile(workerFile) : null;
  const buildInfo = { version: sourceManifest.version, builtAt: new Date().toISOString(), sources, sourceLockSha256: hash(await fs.readFile(path.join(root, 'package-lock.json'))), bundleSha256: hash(bundledCode), bundleBytes: bundledCode.length, workerSha256: workerCode ? hash(workerCode) : null, workerBytes: workerCode?.length || 0, dependencies };
  await fs.writeFile(path.join(nodeDir, 'BUILD.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  await fs.writeFile(path.join(nodeDir, 'README.md'), `# Earlyx ${sourceManifest.version}\n\nThis archive includes a bundled compiler, fonts, a local web editor, examples, licenses, and available stage reports. Node.js 22 or newer is required for this smaller distribution. No npm install is needed.\n\nRun from this directory:\n\n\`\`\`sh\nnode bin/earlyx.js serve\nnode bin/earlyx.js compile examples/showcase.ex\n\`\`\`\n\nRead docs/language.md and docs/distribution.md for scope and usage.\n`);
  const nodeSmoke = await smokeTest(nodeDir, false);
  await fs.cp(nodeDir, runtimeDir, { recursive: true });
  await fs.copyFile(process.execPath, path.join(runtimeDir, 'bin', 'node'));
  await fs.chmod(path.join(runtimeDir, 'bin', 'node'), 0o755);
  const nodeLicense = path.resolve(path.dirname(process.execPath), '..', 'LICENSE');
  if (!(await exists(nodeLicense))) throw new Error('Cannot locate the Node.js runtime license; refusing to package runtime without notices.');
  await fs.mkdir(path.join(runtimeDir, 'LICENSES', 'node-runtime'), { recursive: true });
  await fs.copyFile(nodeLicense, path.join(runtimeDir, 'LICENSES', 'node-runtime', 'LICENSE'));
  await fs.writeFile(path.join(runtimeDir, 'earlyx'), '#!/bin/sh\nEARLYX_INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$EARLYX_INSTALL_DIR/bin/node" "$EARLYX_INSTALL_DIR/bin/earlyx.js" "$@"\n');
  await fs.chmod(path.join(runtimeDir, 'earlyx'), 0o755);
  const runtimeInfo = { ...buildInfo, runtime: { version: process.version, platform: process.platform, arch: process.arch, sha256: hash(await fs.readFile(process.execPath)) } };
  await fs.writeFile(path.join(runtimeDir, 'BUILD.json'), JSON.stringify(runtimeInfo, null, 2) + '\n');
  await fs.writeFile(path.join(runtimeDir, 'README.md'), `# Earlyx ${sourceManifest.version}\n\nSelf-contained offline distribution for ${process.platform}/${process.arch}, including Node.js ${process.version}. No npm, TeX installation, or host Node.js is required.\n\n\`\`\`sh\n./earlyx serve\n./earlyx compile examples/showcase.ex\n\`\`\`\n\nRun these from the extracted directory. To compile another project, pass --root /absolute/path/to/project. Other operating systems and CPU architectures require a matching runtime build and have not been verified by this archive. See docs/distribution.md and LICENSES.\n`);
  const runtimeSmoke = await smokeTest(runtimeDir, true);
  const stem = `earlyx-${sourceManifest.version}`;
  const archives = [`${stem}-node.tar.gz`, `${stem}-${process.platform}-${process.arch}.tar.gz`];
  execFileSync('tar', ['-czf', path.join(destination, archives[0]), 'earlyx-node'], { cwd: destination, timeout: 60_000 });
  execFileSync('tar', ['-czf', path.join(destination, archives[1]), 'earlyx-runtime'], { cwd: destination, timeout: 60_000 });
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const pack = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts', '--json', '--cache', path.join(destination, '.npm-cache'), '--pack-destination', destination], { cwd: nodeDir, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 }));
  await fs.rm(path.join(destination, '.npm-cache'), { recursive: true, force: true });
  if (pack[0]?.filename) archives.push(pack[0].filename);
  const files = [];
  for (const filename of archives) {
    const data = await fs.readFile(path.join(destination, filename));
    files.push({ filename, bytes: data.length, sha256: hash(data) });
  }
  await fs.writeFile(path.join(destination, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.filename}`).join('\n') + '\n');
  const sourcesAfterBuild = await sourceFingerprint();
  if (sourcesAfterBuild.sha256 !== sources.sha256) throw new Error('Production source changed during the build; rebuild from a stable source tree.');
  const report = { version: sourceManifest.version, platform: process.platform, arch: process.arch, sources, bundleBytes: bundledCode.length, buildMs: elapsed(started), smokeTests: [nodeSmoke, runtimeSmoke], files };
  await fs.writeFile(path.join(destination, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, sources: { sha256: sources.sha256, files: sources.files.length } }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
