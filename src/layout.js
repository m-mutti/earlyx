import { createHash } from 'node:crypto';
import { chooseFont, shape } from './fonts.js';
import { renderMath } from './math.js';
import { parseInline } from './language.js';

const sizes = { a4: [595.276, 841.89], letter: [612, 792], a5: [419.528, 595.276] };
const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function resolveDocument(document) {
  const refs = Object.create(null);
  const citations = new Map();
  const footnoteReferences = Object.create(null);
  let currentBlockId;
  const counters = { figure: 0, table: 0, math: 0 };
  const headingCounts = [0, 0, 0, 0, 0, 0];
  const visitInline = nodes => { for (const n of nodes || []) { if (n.type === 'cite' && !citations.has(n.key || n.target || n.text)) citations.set(n.key || n.target || n.text, citations.size + 1); if (n.type === 'footnote' && !footnoteReferences[n.key]) footnoteReferences[n.key] = currentBlockId; if (n.children) visitInline(n.children); } };
  for (const block of document.blocks) {
    currentBlockId = block.label || block.id;
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, block.level || 1));
      headingCounts[level - 1]++;
      headingCounts.fill(0, level);
      block.number = headingCounts.slice(0, level).join('.');
    } else if (counters[block.type] !== undefined) block.number = ++counters[block.type];
    const label = block.label || block.attrs?.id;
    if (label) {
      if (refs[label]) document.diagnostics.push({ severity: 'error', message: `Duplicate label: ${label}`, source: block.source });
      refs[label] = { text: block.type === 'heading' ? `Section ${block.number}` : `${block.type === 'math' ? 'Equation' : block.type[0].toUpperCase() + block.type.slice(1)} ${block.number || ''}`.trim(), id: label, blockId: block.id };
    }
    visitInline(block.inline || parseInline(block.text || ''));
    for (const item of block.items || []) visitInline(item.inline || parseInline(item.text || String(item)));
    for (const row of block.rows || []) for (const cell of row) visitInline(parseInline(String(cell)));
  }
  document.references = refs;
  document.footnoteReferences = footnoteReferences;
  document.citations = Object.fromEntries(citations);
  const reported = new Set();
  document.resolveInline = (nodes, source) => (nodes || []).map(node => {
    const n = { ...node };
    if (n.type === 'ref') {
      const target = n.key || String(n.target || n.text).replace(/^#/, '');
      n.text = refs[target]?.text || `??${target}`;
      n.target = '#' + target;
      if (!refs[target] && !reported.has(`ref:${target}`)) { document.diagnostics.push({ severity: 'error', message: `Unknown reference: ${target}`, source }); reported.add(`ref:${target}`); }
    }
    if (n.type === 'cite') {
      const key = n.key || String(n.target || n.text).replace(/^#bib-/, '');
      n.text = `[${citations.get(key) || '?'}]`;
      n.target = '#bib-' + key;
      if (!document.bibliographyData?.[key] && !reported.has(`cite:${key}`)) { document.diagnostics.push({ severity: 'error', message: `Missing bibliography entry: ${key}`, source }); reported.add(`cite:${key}`); }
    }
    if (n.type === 'footnote') {
      const key = n.key || n.target || n.text;
      n.key = key;
      n.text = `[${key}]`;
      if (!document.footnotes?.[key] && !reported.has(`note:${key}`)) { document.diagnostics.push({ severity: 'error', message: `Unknown footnote: ${key}`, source }); reported.add(`note:${key}`); }
    }
    if (n.children) n.children = document.resolveInline(n.children, source);
    return n;
  });
  return document;
}

function inlineTokens(nodes, style, doc, source) {
  const result = [];
  const visit = (list, attrs = {}) => {
    for (const node of doc.resolveInline(list, source)) {
      doc.checkAbort?.();
      const a = { ...attrs };
      if (node.type === 'strong') a.font = style.font === 'sans' ? 'sansBold' : 'bold';
      if (node.type === 'emphasis') a.font = style.font === 'sans' ? 'sansItalic' : 'italic';
      if (node.type === 'code') a.font = 'mono';
      if (['link', 'ref', 'cite'].includes(node.type)) { a.link = node.target || node.href; a.color = style.accent || '#225b72'; }
      if (node.type === 'footnote') { a.footnote = node.key; a.color = '#225b72'; }
      if (node.children?.length) { visit(node.children, a); continue; }
      if (node.type === 'math') {
        const math = renderMath(node.text || node.expression || '', style.fontSize, false);
        if (math.error) doc.diagnostics.push({ severity: 'error', message: 'Invalid mathematical expression', source });
        result.push({ type: 'math', ...math, fontSize: style.fontSize, color: style.color, ...a });
        continue;
      }
      const text = String(node.text ?? '');
      for (const { segment } of segmenter.segment(text)) {
        const font = chooseFont(segment, a.font || style.font || 'serif');
        const size = a.footnote ? style.fontSize * 0.8 : style.fontSize;
        const measured = shape(segment, font, size);
        result.push({ type: 'text', text: segment, font, fontSize: size, width: measured.width,
          height: size, ascent: measured.ascent, descent: measured.descent,
          color: style.color, whitespace: /^\s+$/u.test(segment), ...a });
      }
    }
  };
  visit(nodes);
  return result;
}

function wrap(tokens, width, style, checkAbort = () => {}) {
  const lines = [];
  let line = [], used = 0;
  const flush = () => {
    while (line.at(-1)?.whitespace) { used -= line.pop().width; }
    if (!line.length) return;
    const ascent = Math.max(style.fontSize, ...line.map(t => t.type === 'math' ? t.height - t.descent : t.ascent || t.fontSize));
    const descent = Math.max(style.fontSize * 0.3, ...line.map(t => t.descent || 0));
    const height = Math.max(style.fontSize * style.lineHeight, ascent + descent + 2);
    lines.push({ tokens: line, width: used, availableWidth: width, height, ascent, notes: [...new Set(line.map(t => t.footnote).filter(Boolean))] });
    line = []; used = 0;
  };
  for (const token of tokens) {
    checkAbort();
    if (!line.length && token.whitespace) continue;
    if (used + token.width > width && line.length) flush();
    if (!line.length && token.whitespace) continue;
    // Break unspaced long runs safely at grapheme boundaries.
    if (token.type === 'text' && token.width > width && token.text.length > 1) {
      const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const { segment } of graphemes.segment(token.text)) {
        const part = { ...token, text: segment, width: shape(segment, token.font, token.fontSize).width };
        if (used + part.width > width && line.length) flush();
        line.push(part); used += part.width;
      }
    } else {
      line.push(token); used += token.width;
    }
  }
  flush();
  if (lines.length) lines.at(-1).last = true;
  return lines;
}

export class LayoutEngine {
  constructor() { this.cache = new Map(); }
  layout(doc, { checkAbort = () => {} } = {}) {
    const pageSize = sizes[String(doc.page?.size || 'a4').toLowerCase()] || sizes.a4;
    const width = bounded(doc.page?.width, pageSize[0], 72, 2000);
    const height = bounded(doc.page?.height, pageSize[1], 72, 2000);
    const margin = bounded(doc.page?.margin, 52, 0, Math.max(0, Math.min(width, height) / 2 - 18));
    const contentWidth = width - 2 * margin;
    const base = { fontSize: bounded(doc.style?.fontSize, 11, 1, 200), lineHeight: bounded(doc.style?.lineHeight, 1.5, 0.5, 5),
      font: ['serif', 'sans', 'mono'].includes(doc.style?.font) ? doc.style.font : 'serif', align: doc.style?.align || 'left', color: /^#[\da-f]{6}$/i.test(doc.style?.color || '') ? doc.style.color : '#23313b', accent: /^#[\da-f]{6}$/i.test(doc.style?.accent || '') ? doc.style.accent : '#225b72' };
    const pages = [];
    let page, y, hits = 0, misses = 0, currentSource;
    const oversizedReported = new Set();
    const newPage = () => { page = { number: pages.length + 1, width, height, items: [], notes: new Set(), noteHeight: 0 }; pages.push(page); y = margin; };
    newPage();
    const noteLayouts = new Map();
    const getNote = key => {
      if (!noteLayouts.has(key)) {
        const value = doc.footnotes?.[key];
        const text = typeof value === 'string' ? value : value?.text || '';
        const style = { ...base, fontSize: base.fontSize * 0.8, lineHeight: 1.35 };
        noteLayouts.set(key, wrap(inlineTokens(parseInline(`[${key}] ${text}`), style, doc, value?.source), contentWidth, style, checkAbort));
      }
      return noteLayouts.get(key);
    };
    const noteSpace = notes => notes.filter(key => !page.notes.has(key)).reduce((h, key) => h + getNote(key).reduce((n,l) => n + l.height, 0) + 4, 0);
    const ensure = (space, notes = []) => {
      const added = noteSpace(notes);
      const separator = page.noteHeight || !added ? 0 : 15;
      if (y + space + page.noteHeight + added + separator > height - margin && y > margin + 0.1) newPage();
      if (space + page.noteHeight + noteSpace(notes) + 15 > height - 2 * margin) {
        const key = `${currentSource?.file}:${currentSource?.start}`;
        if (!oversizedReported.has(key)) {
          doc.diagnostics.push({ severity: 'error', message: 'This content and its footnotes exceed the height of a page. Shorten the note, reduce the font size, or increase the page size.', source: currentSource });
          oversizedReported.add(key);
        }
      }
      for (const key of notes) if (!page.notes.has(key)) { page.notes.add(key); page.noteHeight += getNote(key).reduce((n,l) => n + l.height, 0) + 4 + (page.notes.size === 1 ? 15 : 0); }
    };
    const emitLine = (line, block, x = margin, role = 'P', forcedY) => {
      const top = forcedY ?? y;
      const spare = Math.max(0, (line.availableWidth || line.width) - line.width);
      const align = line.align || base.align;
      let cursor = x + (align === 'center' ? spare / 2 : align === 'right' ? spare : 0);
      const spaces = line.tokens.filter(t => t.whitespace).length;
      const justify = align === 'justify' && !line.last && spaces ? spare / spaces : 0;
      // Full Arabic words are shaped by the shared engine. Mixed-direction paragraphs
      // are diagnosed below until paragraph-level bidi is implemented.
      for (const token of line.tokens) {
        page.items.push({ ...token, x: cursor, y: top + line.ascent, width: token.width,
          height: line.height, source: block.source, blockId: block.id, role, label: block.label });
        cursor += token.width + (token.whitespace ? justify : 0);
      }
      if (forcedY === undefined) y += line.height;
    };
    const cachedLines = (text, inline, style, availableWidth, source) => {
      const resolved = doc.resolveInline(inline || parseInline(text), source);
      const key = hash([resolved, style, availableWidth]);
      if (this.cache.has(key)) { hits++; return this.cache.get(key); }
      misses++;
      const result = wrap(inlineTokens(resolved, style, doc, source), availableWidth, style, checkAbort);
      for (const line of result) line.align = style.align || 'left';
      this.cache.set(key, result);
      if (this.cache.size > 3000) this.cache.delete(this.cache.keys().next().value);
      return result;
    };
    const paragraph = (text, block, { style = base, indent = 0, role = 'P', gap = 7, inline } = {}) => {
      const lines = cachedLines(text, inline, style, contentWidth - indent, block.source);
      for (let i = 0; i < lines.length; i++) {
        const next = lines[i + 1];
        ensure(lines[i].height + (i === 0 && next ? next.height : 0), lines[i].notes);
        emitLine(lines[i], block, margin + indent, role);
      }
      y += gap;
    };
    if (doc.metadata?.title) {
      paragraph(doc.metadata.title, { id: 'document-title', source: { file: doc.filename || '', line: 1, start: 0, end: 0 } }, { style: { ...base, font: base.font === 'sans' ? 'sansBold' : 'bold', fontSize: 29, lineHeight: 1.15 }, role: 'H1', gap: 12 });
      if (doc.metadata.author) paragraph(doc.metadata.author, { id: 'document-author' }, { style: { ...base, font: 'italic', fontSize: 11 }, gap: 22 });
    }
    for (const block of doc.blocks) {
      checkAbort();
      currentSource = block.source;
      if (/[\u0600-\u06ff]/u.test(block.text || '')) doc.diagnostics.push({ severity: 'warning', message: 'Arabic glyph shaping is supported; paragraph-level bidirectional ordering is not yet supported.', source: block.source });
      if (block.type === 'heading') {
        const level = Math.max(1, Math.min(6, block.level || 1));
        const style = { ...base, font: base.font === 'sans' ? 'sansBold' : 'bold', fontSize: [20, 16, 13, 12, 11, 11][level - 1], lineHeight: 1.25 };
        const lines = cachedLines(block.text, block.inline, style, contentWidth, block.source);
        ensure(lines.reduce((n,l) => n + l.height, 0) + base.fontSize * 3 + 12);
        if (y > margin) y += 12;
        for (const line of lines) emitLine(line, block, margin, `H${Math.min(level + (doc.metadata.title ? 1 : 0), 6)}`);
        y += 8;
      } else if (block.type === 'paragraph') paragraph(block.text, block, { inline: block.inline });
      else if (block.type === 'list') {
        const numbers = [];
        for (let i = 0; i < block.items.length; i++) {
          const item = block.items[i];
          const level = Math.min(8, Math.max(0, item.level || 0));
          numbers[level] = (numbers[level] ?? (level === 0 ? (block.start || 1) : 1) - 1) + 1;
          numbers.length = level + 1;
          const indent = 18 * (level + 1);
          const text = item.text ?? String(item);
          const lines = cachedLines(text, item.inline, base, contentWidth - indent, block.source);
          if (!lines.length) continue;
          ensure(lines[0].height, lines[0].notes);
          const bullet = inlineTokens(parseInline(block.ordered ? `${numbers[level]}.` : '•'), base, doc, block.source);
          emitLine({ ...lines[0], tokens: bullet, align: 'left' }, block, margin + indent - 18, 'Lbl', y);
          for (const line of lines) { ensure(line.height, line.notes); emitLine(line, block, margin + indent, 'LBody'); }
          y += 4;
        }
        y += 4;
      } else if (block.type === 'code') {
        const style = { ...base, font: 'mono', fontSize: Math.min(base.fontSize, 9), lineHeight: 1.4, align: 'left' };
        for (const text of (block.text || '').split('\n')) {
          const lines = cachedLines(text || ' ', [{ type: 'text', text: text || ' ' }], style, contentWidth - 20, block.source);
          for (const line of lines) {
            ensure(line.height + 4);
            page.items.push({ type: 'rect', x: margin, y, width: contentWidth, height: line.height + 4, color: '#f0f4f5', role: 'Artifact' });
            emitLine(line, block, margin + 10, 'Code');
          }
        }
        y += 10;
      } else if (block.type === 'math') {
        const math = renderMath(block.text || block.expression || '', base.fontSize * 1.2, true);
        if (math.error) doc.diagnostics.push({ severity: 'error', message: 'Invalid mathematical expression', source: block.source });
        const scale = Math.min(1, contentWidth / Math.max(1, math.width), Math.max(1, height - 2 * margin - 22) / Math.max(1, math.height));
        ensure(math.height * scale + 22);
        page.items.push({ type: 'math', ...math, x: margin + (contentWidth - math.width * scale) / 2,
          y: y + 8, width: math.width * scale, height: math.height * scale, topAligned: true,
          source: block.source, blockId: block.id, role: 'Formula', label: block.label });
        y += math.height * scale + 22;
      } else if (block.type === 'table') {
        const rows = [...(block.headers?.length ? [block.headers] : []), ...(block.rows || [])];
        const columns = Math.max(1, ...rows.map(r => r.length));
        const colWidth = contentWidth / columns;
        const rowLayouts = rows.map((row, r) => {
          const style = { ...base, font: r === 0 && block.headers?.length ? 'bold' : base.font, fontSize: Math.min(base.fontSize, 10) };
          const cells = Array.from({ length: columns }, (_, c) => cachedLines(String(row[c] ?? ''), null, style, colWidth - 16, block.source));
          return { cells, height: Math.max(style.fontSize * style.lineHeight, ...cells.map(lines => lines.reduce((n,l) => n + l.height, 0))) + 14 };
        });
        const drawRow = (row, header) => {
          ensure(row.height);
          const top = y;
          page.items.push({ type: 'rect', x: margin, y: top, width: contentWidth, height: row.height, color: header ? '#e7eef0' : '#ffffff', stroke: '#ccd7dc', role: 'Artifact' });
          row.cells.forEach((lines, c) => { let cy = top + 7; for (const line of lines) { emitLine(line, block, margin + c * colWidth + 8, header ? 'TH' : 'TD', cy); cy += line.height; } });
          y = top + row.height;
        };
        const splitRow = (row, maxHeight) => {
          if (row.height <= maxHeight) return [row];
          const remaining = row.cells.map(lines => [...lines]);
          const fragments = [];
          while (remaining.some(lines => lines.length)) {
            const cells = remaining.map(lines => {
              const chunk = [];
              let used = 0;
              while (lines.length && used + lines[0].height <= maxHeight - 14) { const line = lines.shift(); chunk.push(line); used += line.height; }
              return chunk;
            });
            if (!cells.some(lines => lines.length)) {
              doc.diagnostics.push({ severity: 'error', message: 'A table row cannot fit a line within this page size and margins. Increase the page size or reduce the margins.', source: block.source });
              break;
            }
            fragments.push({ cells, height: Math.max(...cells.map(lines => lines.reduce((n,l) => n + l.height, 0))) + 14 });
          }
          return fragments;
        };
        const header = block.headers?.length ? rowLayouts[0] : null;
        const drawableRows = rowLayouts.flatMap((row, index) => splitRow(row, height - 2 * margin - (index > 0 && header ? header.height : 0)).map(fragment => ({ ...fragment, isHeader: index === 0 && !!header })));
        for (let r = 0; r < drawableRows.length; r++) {
          const before = page.number;
          ensure(drawableRows[r].height + (r === 0 && drawableRows[1] ? drawableRows[1].height : 0));
          if (page.number !== before && !drawableRows[r].isHeader && header && header.height + drawableRows[r].height <= height - 2 * margin) drawRow(header, true);
          drawRow(drawableRows[r], drawableRows[r].isHeader);
        }
        y += 8;
        if (block.caption) paragraph(`Table ${block.number}. ${block.caption}`, block, { style: { ...base, fontSize: 9, font: 'italic' }, role: 'Caption' });
      } else if (block.type === 'figure') {
        const image = block.asset;
        if (!image) continue;
        const scale = Math.min(contentWidth / image.width, (height - 2 * margin - 65) / image.height, 1);
        const w = image.width * scale, h = image.height * scale;
        ensure(h + 55);
        page.items.push({ type: image.type, ...image, x: margin + (contentWidth - w) / 2, y, width: w, height: h,
          role: 'Figure', alt: block.alt || block.caption || 'Figure', source: block.source, blockId: block.id, label: block.label });
        y += h + 8;
        if (block.caption) paragraph(`Figure ${block.number}. ${block.caption}`, block, { style: { ...base, fontSize: 9, font: 'italic' }, role: 'Caption' });
      } else if (block.type === 'toc') {
        paragraph(block.title || 'Contents', block, { style: { ...base, font: 'bold', fontSize: 13 }, role: 'H2', gap: 6 });
        for (const heading of doc.blocks.filter(b => b.type === 'heading')) {
          paragraph(heading.text, block, { style: { ...base, fontSize: 10 }, indent: ((heading.level || 1) - 1) * 12, gap: 3,
            inline: [{ type: 'link', text: heading.text, target: '#' + (heading.label || heading.id) }] });
        }
        y += 10;
      } else if (block.type === 'pagebreak') newPage();
      else if (block.type === 'bibliography') {
        paragraph(block.title || 'References', block, { style: { ...base, font: 'bold', fontSize: 17 }, role: 'H2', gap: 10 });
        for (const [key, number] of Object.entries(doc.citations)) {
          const entry = doc.bibliographyData?.[key];
          const text = entry ? `[${number}] ${[Array.isArray(entry.author) ? entry.author.join(', ') : entry.author, entry.title, entry.year, entry.url].filter(Boolean).join('. ')}` : `[${number}] Missing entry: ${key}`;
          paragraph(text, { ...block, id: `bib-${key}`, label: `bib-${key}` }, { style: { ...base, fontSize: 9.5 }, role: 'BibEntry' });
        }
      }
    }
    for (const p of pages) {
      page = p;
      let noteY = height - margin - p.noteHeight + 12;
      if (p.notes.size) {
        p.items.push({ type: 'line', x: margin, y: noteY - 7, width: 90, height: 0, color: '#8ca0ab', role: 'Artifact' });
        for (const key of p.notes) {
          for (const line of getNote(key)) { emitLine(line, { id: `note-${key}`, source: doc.footnotes?.[key]?.source }, margin, 'Note', noteY); noteY += line.height; }
          noteY += 4;
        }
      }
      if (margin >= 16) p.items.push({ type: 'text', text: String(p.number), font: 'serif', fontSize: 9, color: '#6e808c', x: width / 2 - 3, y: height - margin / 2, width: 10, height: 12, role: 'Artifact' });
      p.notes = [...p.notes];
    }
    return { pages, width, height, margin, style: base, cacheHits: hits, cacheMisses: misses };
  }
}
