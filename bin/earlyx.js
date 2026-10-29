#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HELP = `Earlyx — one source, PDF and web.

Usage:
  earlyx compile <file.ex> [--out <directory>] [--root <project>]
  earlyx watch <file.ex> [--out <directory>] [--root <project>]
  earlyx serve [--port 4317] [--root <project>]
  earlyx --help

compile writes .html, .web.html, .pdf, .layout.json and .timings.json.
watch rebuilds when the source, includes, bibliography or assets change.
serve starts the local playground (bound to 127.0.0.1).
`;

function argumentsOf(argv) {
  const options = { command: argv[0], positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    if (['--out', '--root', '--port'].includes(argument)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      options[argument.slice(2)] = argv[++i];
    } else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}.`);
    else options.positional.push(argument);
  }
  return options;
}

async function atomicWrite(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, content); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

async function writeResult(output, basename, result) {
  await fs.mkdir(output, { recursive: true });
  const files = [
    [`${basename}.html`, result.html || ''],
    [`${basename}.web.html`, result.webHtml || ''],
    [`${basename}.layout.json`, `${JSON.stringify(result.layout, null, 2)}\n`],
    [`${basename}.timings.json`, `${JSON.stringify({ ...result.stats, diagnostics: result.diagnostics || [] }, null, 2)}\n`],
  ];
  if (result.pdf?.length) files.push([`${basename}.pdf`, result.pdf]);
  else await fs.unlink(path.join(output, `${basename}.pdf`)).catch(() => {});
  await Promise.all(files.map(([name, content]) => atomicWrite(path.join(output, name), content)));
}

function report(result, output) {
  for (const diagnostic of result.diagnostics || []) {
    const source = diagnostic.source || {};
    const location = source.line ? `:${source.line}:${source.column || 1}` : '';
    console.error(`${diagnostic.severity || 'warning'}${source.file ? ` ${source.file}${location}` : location}: ${diagnostic.message}`);
  }
  const stats = result.stats || {};
  const ms = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
  console.log(`Compiled ${stats.pages ?? result.layout?.pages?.length ?? '—'} pages in ${ms(stats.totalMs)} ms (parse ${ms(stats.parseMs)}, layout ${ms(stats.layoutMs)}, render ${ms(stats.renderMs)}; ${stats.cacheHits ?? 0} cached / ${stats.cacheMisses ?? 0} new).`);
  console.log(`Output: ${output}`);
}

function dependencyPaths(result, root, source) {
  const paths = new Set([source]);
  for (const dependency of result?.document?.dependencies || []) {
    const value = typeof dependency === 'string' ? dependency : dependency.resolved || dependency.path;
    if (value) paths.add(path.resolve(root, value));
  }
  return paths;
}

async function stamp(filename) {
  try { const stat = await fs.stat(filename); return `${stat.mtimeMs}:${stat.size}:${stat.ino}`; }
  catch { return 'missing'; }
}

export async function runCLI(argv = process.argv.slice(2)) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) { console.log(HELP); return; }
  if (['--version', '-v'].includes(argv[0])) {
    const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(manifest.version); return;
  }
  const options = argumentsOf(argv);
  if (!['compile', 'watch', 'serve'].includes(options.command)) throw new Error(`Unknown command ${options.command}. Use --help.`);
  const root = await fs.realpath(path.resolve(options.root || process.cwd()));
  if (options.command === 'serve') {
    if (options.positional.length) throw new Error('serve does not accept a filename.');
    const port = options.port === undefined ? 4317 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
    const { startServer } = await import('../src/server.js');
    const { server, url } = await startServer({ rootDir: root, port });
    console.log(`Earlyx playground: ${url}`);
    console.log(`Project: ${root}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => process.exit(0)); });
    return;
  }
  if (options.positional.length !== 1) throw new Error(`${options.command} needs one source file. Use --help.`);
  const input = path.resolve(root, options.positional[0]);
  if (input !== root && !input.startsWith(root + path.sep)) throw new Error('Source file must remain inside --root.');
  const basename = path.basename(input, path.extname(input));
  const output = path.resolve(root, options.out || path.join('artifacts', basename));
  const { createCompiler } = await import('../src/compiler.js');
  const compiler = createCompiler({ rootDir: root });
  let result;
  let lastDependencies = new Set([input]);
  async function build() {
    const realInput = await fs.realpath(input);
    if (realInput !== root && !realInput.startsWith(root + path.sep)) throw new Error('Source symlink must remain inside --root.');
    const source = await fs.readFile(realInput, 'utf8');
    result = await compiler.compile(source, { filename: path.relative(root, realInput), pdf: true });
    await writeResult(output, basename, result);
    lastDependencies = dependencyPaths(result, root, input);
    report(result, output);
    return result;
  }
  if (options.command === 'compile') {
    await build();
    if (result.diagnostics?.some(diagnostic => diagnostic.severity === 'error')) process.exitCode = 1;
    return result;
  }

  try { await build(); }
  catch (error) { console.error(`Build failed: ${error.message}`); }
  let stamps = new Map(await Promise.all([...lastDependencies].map(async file => [file, await stamp(file)])));
  let running = false;
  let stopped = false;
  console.log(`Watching ${lastDependencies.size} source and dependency files. Press Ctrl+C to stop.`);
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      let changed = false;
      for (const [file, previous] of stamps) if (await stamp(file) !== previous) { changed = true; break; }
      if (!changed) return;
      console.log('Change detected. Rebuilding…');
      try { await build(); }
      catch (error) { console.error(`Build failed: ${error.message}`); }
      // Preserve missing dependencies from a failed build, so restoring a file
      // triggers recovery without restarting watch.
      for (const file of lastDependencies) if (!stamps.has(file)) stamps.set(file, 'new');
      stamps = new Map(await Promise.all([...stamps.keys()].map(async file => [file, await stamp(file)])));
      console.log(`Watching ${stamps.size} source and dependency files.`);
    } finally { running = false; }
  }, 180);
  const stop = () => { stopped = true; clearInterval(timer); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { stop, get result() { return result; } };
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  runCLI().catch(error => { console.error(`earlyx: ${error.message}`); process.exitCode = 1; });
}
