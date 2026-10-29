import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const cli = fileURLToPath(new URL('../bin/earlyx.js', import.meta.url));

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-cli-'));
  await fs.writeFile(path.join(root, 'main.ex'), '@title "CLI document"\n\n# Main heading\n\n@include("chapter.ex")\n');
  await fs.writeFile(path.join(root, 'chapter.ex'), 'The first included paragraph.\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* The first atomic output may not exist yet. */ }
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test('compile writes both HTML modes, PDF, layout and measured timings', async t => {
  const root = await project(t);
  const result = await command(['compile', 'main.ex', '--root', root, '--out', 'out']);
  assert.equal(result.code, 0, result.stderr);
  const expected = ['main.html', 'main.web.html', 'main.pdf', 'main.layout.json', 'main.timings.json'];
  assert.deepEqual((await fs.readdir(path.join(root, 'out'))).sort(), expected.sort());
  assert.match(await fs.readFile(path.join(root, 'out', 'main.web.html'), 'utf8'), /The first included paragraph/);
  const pdf = await fs.readFile(path.join(root, 'out', 'main.pdf'));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const timings = JSON.parse(await fs.readFile(path.join(root, 'out', 'main.timings.json'), 'utf8'));
  assert.ok(timings.totalMs > 0);
  assert.ok(timings.layoutMs >= 0);
  assert.equal(timings.pages, 1);
  const layout = JSON.parse(await fs.readFile(path.join(root, 'out', 'main.layout.json'), 'utf8'));
  assert.equal(layout.pages.length, 1);
  assert.match(result.stdout, /Compiled 1 pages in [\d.]+ ms/);
});

test('compile retains inspectable outputs and exits nonzero on source errors', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'main.ex'), '# Valid heading\n\n@unsupported("x")\n');
  const result = await command(['compile', 'main.ex', '--root', root, '--out', 'out']);
  assert.equal(result.code, 1);
  const timings = JSON.parse(await fs.readFile(path.join(root, 'out', 'main.timings.json'), 'utf8'));
  assert.ok(timings.diagnostics.some(item => item.severity === 'error'));
  assert.match(await fs.readFile(path.join(root, 'out', 'main.web.html'), 'utf8'), /Valid heading/);
});

test('CLI refuses source symlinks outside the declared project', async t => {
  const root = await project(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'earlyx-cli-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'private.ex'), '# Private document\n');
  await fs.symlink(path.join(outside, 'private.ex'), path.join(root, 'linked.ex'));
  const result = await command(['compile', 'linked.ex', '--root', root, '--out', 'out']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Source symlink must remain inside/);
  await assert.rejects(fs.stat(path.join(root, 'out')), { code: 'ENOENT' });
});

test('CLI entry point works through installation symlinks', async t => {
  const root = await project(t);
  const link = path.join(root, 'earlyx.js');
  await fs.symlink(cli, link);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [link, '--version']);
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout }));
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/);
});

test('watch rebuilds after included files, dependencies and source edits', async t => {
  const root = await project(t);
  const child = spawn(process.execPath, [cli, 'watch', 'main.ex', '--root', root, '--out', 'out']);
  let log = '', errors = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('close', resolve));
    }
  });
  const output = path.join(root, 'out', 'main.web.html');
  const text = () => fs.readFile(output, 'utf8');
  await waitFor(async () => (await text()).includes('The first included paragraph') && log.includes('Watching '), 'initial watch build');
  await fs.writeFile(path.join(root, 'chapter.ex'), 'The changed included paragraph.\n');
  await waitFor(async () => (await text()).includes('The changed included paragraph'), 'included file rebuild');
  await fs.writeFile(path.join(root, 'references.json'), JSON.stringify({ paper: { author: 'A Writer', title: 'Original reference', year: 2026 } }));
  await fs.writeFile(path.join(root, 'main.ex'), '# Revised source\n\n@include("chapter.ex")\n\nA reference @cite("paper").\n\n@bibliography("references.json")\n');
  await waitFor(async () => (await text()).includes('Original reference'), 'new dependency discovery');
  await fs.writeFile(path.join(root, 'references.json'), JSON.stringify({ paper: { author: 'A Writer', title: 'Updated reference', year: 2026 } }));
  await waitFor(async () => (await text()).includes('Updated reference'), 'bibliography rebuild');
  await fs.writeFile(path.join(root, 'main.ex'), '# Source recovery\n\n@include("created-later.ex")\n');
  await waitFor(async () => errors.includes('created-later.ex'), 'missing dependency diagnostic');
  await fs.writeFile(path.join(root, 'created-later.ex'), 'A newly created include recovers automatically.\n');
  await waitFor(async () => (await text()).includes('A newly created include recovers automatically'), 'missing include recovery');
  assert.match(log, /Change detected\. Rebuilding/);
  assert.match(errors, /Cannot include created-later.ex/);
});
