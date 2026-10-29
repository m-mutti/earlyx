import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parse } from './language.js';
import { LayoutEngine, resolveDocument } from './layout.js';
import { renderPagedHtml, renderResponsiveHtml, renderPdf } from './render.js';
import { safePath, sanitizeSvg } from './util.js';
import { normalizeSvgText } from './svg.js';

const MAX_FILE_BYTES = 2_000_000;
const MAX_PROJECT_BYTES = 10_000_000;
const MAX_INCLUDES = 128;
const MAX_BLOCKS = 20_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const inProject = (root, target) => target === root || target.startsWith(root + path.sep);

function imageDimensions(svg) {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] || '';
  const viewBox = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const dimension = name => {
    const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([0-9.+-]+)(px|pt|mm|cm|in)?["']`, 'i'));
    if (!value) return null;
    return Number(value[1]) * ({ px: 1, pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 }[value[2]?.toLowerCase() || 'px'] || 1);
  };
  const width = dimension('width') || viewBox?.[2] || 400;
  const height = dimension('height') || viewBox?.[3] || 250;
  if (![width, height].every(number => Number.isFinite(number) && number > 0 && number <= 100_000)) throw new Error('SVG dimensions must be positive and bounded.');
  return { width, height };
}

function bibliographyEntries(data) {
  if (!data || typeof data !== 'object') throw new Error('Bibliography JSON must be a keyed object or an array of entries with ids.');
  const entries = Array.isArray(data) ? data.map(item => [item?.id, item]) : Object.entries(data);
  if (entries.length > 10_000) throw new Error('Bibliography exceeds 10,000 entries.');
  const normalized = Object.create(null);
  for (const [key, entry] of entries) {
    if (typeof key !== 'string' || !key || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each bibliography entry needs an id and an object of fields.');
    const names = entry.author || entry.authors || '';
    const author = Array.isArray(names) ? names.map(name => typeof name === 'string' ? name : [name?.given, name?.family].filter(Boolean).join(' ')) : String(names);
    normalized[key] = {
      author,
      title: String(entry.title || key),
      year: entry.year || entry.issued?.['date-parts']?.[0]?.[0] || '',
      publisher: String(entry.publisher || ''),
      url: String(entry.url || entry.URL || ''),
    };
  }
  return normalized;
}

/** A compiler instance retains paragraph caches across edits, but reads files afresh. */
export function createCompiler({ rootDir = process.cwd() } = {}) {
  const requestedRoot = path.resolve(rootDir);
  const engine = new LayoutEngine();

  async function compile(source, { filename = 'document.ex', pdf = true, cancelFlag, signal } = {}) {
    const started = performance.now();
    const checkAbort = () => {
      if (signal?.aborted || (cancelFlag && Atomics.load(cancelFlag, 0))) {
        const error = new Error('Compilation superseded by a newer edit.');
        error.name = 'AbortError';
        throw error;
      }
    };
    checkAbort();
    const root = await fs.realpath(requestedRoot);
    const suppliedFilename = path.resolve(requestedRoot, filename);
    let absoluteFilename = inProject(requestedRoot, suppliedFilename)
      ? path.resolve(root, path.relative(requestedRoot, suppliedFilename)) : suppliedFilename;
    const diagnostics = [], dependencies = [], footnotes = Object.create(null), bibliographyData = Object.create(null);
    const state = { bytes: Buffer.byteLength(String(source ?? '')), includes: 0, blocks: 0 };
    const report = (code, message, sourceLocation, severity = 'error') => diagnostics.push({
      code, message, severity, source: sourceLocation,
      file: sourceLocation?.file, line: sourceLocation?.line, column: sourceLocation?.column,
    });
    if (!inProject(root, absoluteFilename)) {
      report('project-path', 'The document filename must remain inside the project.', { file: absoluteFilename, line: 1, column: 1, start: 0, end: 0 });
      absoluteFilename = path.join(root, 'document.ex');
    }

    async function readDependency(block, kind, containingFile) {
      let resolved;
      try { resolved = safePath(root, block.path, path.dirname(containingFile)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const intended = path.resolve(path.dirname(containingFile), block.path);
        if (!inProject(root, intended)) throw new Error('File must remain inside the project.');
        let ancestor = path.dirname(intended);
        while (true) {
          try {
            const realAncestor = await fs.realpath(ancestor);
            if (!inProject(root, realAncestor)) throw new Error('File must remain inside the project.');
            const safeIntended = path.resolve(realAncestor, path.relative(ancestor, intended));
            dependencies.push({ path: block.path, resolved: safeIntended, kind, source: block.source, missing: true, hash: null });
            break;
          } catch (parentError) {
            if (parentError.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw parentError;
            ancestor = path.dirname(ancestor);
          }
        }
        throw error;
      }
      const entry = { path: block.path, resolved, kind, source: block.source, hash: null };
      dependencies.push(entry);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error('Dependency must be a file.');
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Dependency exceeds the ${MAX_FILE_BYTES.toLocaleString()} byte file limit.`);
      state.bytes += stat.size;
      if (state.bytes > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 10 MB compilation input limit.');
      const data = await fs.readFile(resolved, 'utf8');
      entry.hash = digest(data);
      return { resolved, data };
    }

    async function load(text, file, stack = [], inheritedComponents = {}) {
      checkAbort();
      const parsed = parse(text, { filename: file, components: inheritedComponents });
      checkAbort();
      diagnostics.push(...parsed.diagnostics);
      const blocks = [];
      for (const [key, definition] of Object.entries(parsed.footnotes)) {
        if (Object.hasOwn(footnotes, key)) report('duplicate-footnote', `Footnote ${key} is already defined in this project.`, definition.source);
        footnotes[key] = definition;
      }
      for (const block of parsed.blocks) {
        checkAbort();
        if (++state.blocks > MAX_BLOCKS) { report('project-blocks', `Project exceeds the ${MAX_BLOCKS.toLocaleString()} block limit.`, block.source); break; }
        if (block.type === 'include') {
          try {
            if (stack.length >= 16) throw new Error('Include nesting exceeds 16 files.');
            if (++state.includes > MAX_INCLUDES) throw new Error(`Project exceeds ${MAX_INCLUDES} include directives.`);
            const { resolved, data } = await readDependency(block, 'include', file);
            if (stack.includes(resolved) || resolved === file) throw new Error(`Include cycle: ${[...stack, file, resolved].map(item => path.relative(root, item)).join(' → ')}.`);
            const child = await load(data, resolved, [...stack, file], parsed.components);
            if (Object.keys(child.metadata).length || /(?:^|\n)\s*@(page|style)\b/.test(data)) report('include-settings', 'Metadata, page settings, and styles in included files do not override the main document.', block.source, 'warning');
            for (const childBlock of child.blocks) {
              const identity = digest(`${path.relative(root, resolved)}:${block.id}:${childBlock.id}`).slice(0, 16);
              childBlock.id = `${childBlock.type}-${identity}`;
              blocks.push(childBlock);
            }
          } catch (error) { report('include', `Cannot include ${block.path}: ${error.message}`, block.source); }
          continue;
        }
        if (block.type === 'bibliography') {
          try {
            const { data } = await readDependency(block, 'bibliography', file);
            const entries = bibliographyEntries(JSON.parse(data));
            for (const [key, entry] of Object.entries(entries)) {
              if (Object.hasOwn(bibliographyData, key)) report('duplicate-citation', `Bibliography entry ${key} is already defined.`, block.source);
              bibliographyData[key] = entry;
            }
          } catch (error) { report('bibliography', `Cannot load bibliography ${block.path}: ${error.message}`, block.source); }
        }
        if (block.type === 'figure') {
          try {
            if (path.extname(block.path).toLowerCase() !== '.svg') throw new Error('This version supports static SVG figures. Convert raster images to a self-contained SVG before including them.');
            const { data } = await readDependency(block, 'figure', file);
            const svg = normalizeSvgText(sanitizeSvg(data)), dimensions = imageDimensions(svg);
            const scale = typeof block.width === 'number' && block.width > 0 ? Math.min(block.width, 2000) / dimensions.width : 1;
            block.asset = { type: 'svg', svg, width: dimensions.width * scale, height: dimensions.height * scale };
          } catch (error) { report('figure', `Cannot load figure ${block.path}: ${error.message}`, block.source); }
        }
        blocks.push(block);
      }
      return { ...parsed, blocks };
    }

    const document = await load(String(source ?? ''), absoluteFilename);
    document.filename = absoluteFilename;
    document.rootDir = root;
    document.dependencies = dependencies;
    document.footnotes = footnotes;
    document.bibliographyData = bibliographyData;
    document.diagnostics = diagnostics;
    Object.defineProperty(document, 'checkAbort', { value: checkAbort });
    resolveDocument(document);
    const parsedAt = performance.now();
    checkAbort();
    const layout = engine.layout(document, { checkAbort });
    const laidOutAt = performance.now();
    checkAbort();
    const html = renderPagedHtml(document, layout, { checkAbort });
    const webHtml = renderResponsiveHtml(document, layout);
    checkAbort();
    const pdfBuffer = pdf ? await renderPdf(document, layout, { checkAbort }) : undefined;
    checkAbort();
    const finished = performance.now();
    return {
      document, layout, html, webHtml, ...(pdfBuffer ? { pdf: pdfBuffer } : {}), diagnostics,
      stats: {
        parseMs: parsedAt - started, layoutMs: laidOutAt - parsedAt,
        renderMs: finished - laidOutAt, totalMs: finished - started,
        cacheHits: layout.cacheHits, cacheMisses: layout.cacheMisses, pages: layout.pages.length,
        inputBytes: state.bytes, dependencyFiles: dependencies.length,
      },
    };
  }

  return { compile, clearCache() { engine.cache.clear(); } };
}
