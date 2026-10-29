import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import SVGtoPDF from 'svg-to-pdfkit';
import { fontPath, shape, glyphPath, fontFiles } from './fonts.js';
import { renderMath } from './math.js';
import { parseInline } from './language.js';
import { escapeHtml as e, safeUrl, round } from './util.js';

const sourceAttrs = source => source ? ` data-source-line="${source.line || 1}" data-source-start="${source.start || 0}" data-source-end="${source.end || 0}" data-source-file="${e(source.file || '')}"` : '';
const fontCssCache = new Map();
const fontFamilies = { serif: ['Earlyx Serif', 400, 'normal'], bold: ['Earlyx Serif', 700, 'normal'], italic: ['Earlyx Serif', 400, 'italic'], mono: ['Earlyx Mono', 400, 'normal'], sans: ['Earlyx Sans', 400, 'normal'], sansBold: ['Earlyx Sans', 700, 'normal'], sansItalic: ['Earlyx Sans', 400, 'italic'], cjk: ['Earlyx CJK', 400, 'normal'], arabic: ['Earlyx Arabic', 400, 'normal'] };
function embeddedFontCss(layout) {
  const names = new Set(layout.pages.flatMap(p => p.items.filter(i => i.type === 'text' && i.role !== 'Artifact').map(i => i.font)));
  return [...names].sort().map(name => {
    if (!fontCssCache.has(name)) {
      const [family, weight, style] = fontFamilies[name];
      fontCssCache.set(name, `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;src:url(data:application/octet-stream;base64,${fs.readFileSync(fontPath(name)).toString('base64')})}`);
    }
    return fontCssCache.get(name);
  }).join('');
}
const pageCss = `*{box-sizing:border-box}body{margin:0;background:#e9edef;color:#23313b;font-family:Georgia,serif}.pages{display:grid;gap:24px;justify-content:center;padding:28px}.page{position:relative;background:white;box-shadow:0 2px 16px #24354416;overflow:hidden}.page>svg{display:block;width:100%;height:100%}.selection{position:absolute;inset:0}.selection span{position:absolute;white-space:pre;color:transparent;line-height:1;cursor:text}.selection span::selection{background:#4a9eba66;color:transparent}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media print{body{background:white}.pages{display:block;padding:0}.page{box-shadow:none;margin:0;break-after:page}.page:last-child{break-after:auto}}`;
const webCss = `*{box-sizing:border-box}body{margin:0;background:#fcfcfa;color:#23313b;font:18px/1.7 Georgia,serif}article{max-width:800px;margin:auto;padding:64px 28px 100px}h1,h2,h3,h4,h5,h6{line-height:1.25;color:#142f3b;scroll-margin-top:24px}h1{font-size:2.4em;letter-spacing:-.035em}h2{margin-top:1.8em}header{border-bottom:1px solid #d5dfe2;padding-bottom:24px;margin-bottom:32px}.author{color:#647781;font-style:italic}a{color:#225b72;text-underline-offset:3px}table{width:100%;border-collapse:collapse;font-size:.9em}th,td{border-bottom:1px solid #d4dfe2;text-align:left;padding:10px 12px;overflow-wrap:anywhere}th{background:#eaf0f2}figure{margin:28px 0}figure>svg,figure>img{max-width:100%;height:auto}figcaption{font-size:.85em;color:#647781;font-style:italic;margin-top:8px}pre{background:#edf2f3;padding:20px;overflow:auto;border-radius:8px;font-size:14px;line-height:1.6}code{font-family:ui-monospace,monospace;font-size:.85em}.math-display{overflow-x:auto;text-align:center;padding:18px 0}.math-inline{display:inline-block;vertical-align:middle}.math-inline svg,.math-display svg{max-width:100%}.math-visual{display:inline-block}.math-semantic{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.footnotes{margin-top:40px;border-top:1px solid #ccd7dc;font-size:.85em}.toc{border-left:3px solid #b7cbd2;padding:4px 18px}.toc ol{padding-left:20px}.pagebreak{display:none}@media(max-width:600px){body{font-size:16px}article{padding:28px 18px 64px}h1{font-size:2em}table{font-size:.8em}th,td{padding:7px}pre{padding:14px}}`;

function mathHtml(expression, display, size = 18) {
  const math = renderMath(expression, size, display);
  const svg = sizeSvg(math.svg, math.width, math.height);
  return `<span class="${display ? 'math-display' : 'math-inline'}"><span class="math-visual" aria-hidden="true">${svg}</span><span class="math-semantic">${math.mathml}</span></span>`;
}

export function inlineHtml(nodes, doc, source) {
  return doc.resolveInline(nodes || [], source).map(n => {
    const body = n.children ? inlineHtml(n.children, doc, source) : e(n.text);
    if (n.type === 'strong') return `<strong>${body}</strong>`;
    if (n.type === 'emphasis') return `<em>${body}</em>`;
    if (n.type === 'code') return `<code>${body}</code>`;
    if (n.type === 'math') return mathHtml(n.text, false);
    if (['link', 'ref', 'cite'].includes(n.type)) return `<a href="${e(safeUrl(n.target || n.href))}">${body}</a>`;
    if (n.type === 'footnote') return `<sup><a href="#note-${e(n.key)}" role="doc-noteref">${body}</a></sup>`;
    return body;
  }).join('');
}

function semanticBody(doc) {
  const out = [];
  if (doc.metadata.title) out.push(`<header><h1>${e(doc.metadata.title)}</h1>${doc.metadata.author ? `<p class="author">${e(doc.metadata.author)}</p>` : ''}</header>`);
  for (const block of doc.blocks) {
    const attr = `${sourceAttrs(block.source)} id="${e(block.label || block.id)}"`;
    const text = () => inlineHtml(block.inline || parseInline(block.text || ''), doc, block.source);
    if (block.type === 'paragraph') out.push(`<p${attr}>${text()}</p>`);
    else if (block.type === 'heading') {
      const level = Math.min(6, (block.level || 1) + (doc.metadata.title ? 1 : 0));
      out.push(`<h${level}${attr}>${text()}</h${level}>`);
    } else if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      const roots = [], stack = [roots];
      for (const item of block.items) {
        let level = Math.min(8, Math.max(0, item.level || 0));
        level = Math.min(level, stack.length);
        if (level && !stack[level - 1]?.length) level = 0;
        if (!stack[level]) stack[level] = stack[level - 1].at(-1).children;
        stack[level].push({ item, children: [] });
        stack.length = level + 1;
      }
      const renderItems = (items, level = 0) => `<${tag}${level === 0 ? attr : ''}${block.ordered && level === 0 && block.start !== 1 ? ` start="${block.start || 1}"` : ''}>${items.map(({ item, children }) => `<li${sourceAttrs(item.source)}>${inlineHtml(item.inline || parseInline(item.text || String(item)), doc, item.source)}${children.length ? renderItems(children, level + 1) : ''}</li>`).join('')}</${tag}>`;
      out.push(renderItems(roots));
    } else if (block.type === 'code') out.push(`<pre${attr}><code>${e(block.text)}</code></pre>`);
    else if (block.type === 'math') out.push(`<div${attr}>${mathHtml(block.text || block.expression, true)}</div>`);
    else if (block.type === 'table') out.push(`<figure${attr}><table>${block.caption ? `<caption>${e(`Table ${block.number}. ${block.caption}`)}</caption>` : ''}${block.headers?.length ? `<thead><tr>${block.headers.map(cell => `<th scope="col">${inlineHtml(parseInline(cell), doc, block.source)}</th>`).join('')}</tr></thead>` : ''}<tbody>${(block.rows || []).map(row => `<tr>${row.map(cell => `<td>${inlineHtml(parseInline(cell), doc, block.source)}</td>`).join('')}</tr>`).join('')}</tbody></table></figure>`);
    else if (block.type === 'figure' && block.asset) {
      const asset = block.asset;
      out.push(`<figure${attr}>${asset.type === 'svg' ? `<div role="img" aria-label="${e(block.alt || block.caption || 'Figure')}">${sizeSvg(asset.svg, asset.width, asset.height)}</div>` : `<img src="${e(asset.dataUri)}" alt="${e(block.alt || block.caption)}" width="${asset.width}" height="${asset.height}">`}${block.caption ? `<figcaption>Figure ${block.number}. ${e(block.caption)}</figcaption>` : ''}</figure>`);
    } else if (block.type === 'bibliography') {
      out.push(`<section${attr} role="doc-bibliography"><h2>${e(block.title || 'References')}</h2><ol>${Object.entries(doc.citations).map(([key]) => {
        const entry = doc.bibliographyData?.[key];
        return `<li id="bib-${e(key)}">${entry ? e([Array.isArray(entry.author) ? entry.author.join(', ') : entry.author, entry.title, entry.year].filter(Boolean).join('. ')) + (entry.url ? ` <a href="${e(safeUrl(entry.url))}">${e(entry.url)}</a>` : '') : `Missing entry: ${e(key)}`}</li>`;
      }).join('')}</ol></section>`);
    } else if (block.type === 'toc') {
      out.push(`<nav${attr} class="toc" aria-label="Table of contents"><strong>${e(block.title || 'Contents')}</strong><ol>${doc.blocks.filter(b => b.type === 'heading').map(b => `<li><a href="#${e(b.label || b.id)}">${e(b.text)}</a></li>`).join('')}</ol></nav>`);
    }
  }
  if (Object.keys(doc.footnotes || {}).length) out.push(`<section class="footnotes" role="doc-endnotes" aria-label="Footnotes"><ol>${Object.entries(doc.footnotes).map(([key, note]) => `<li id="note-${e(key)}">${inlineHtml(note.inline || parseInline(note.text || String(note)), doc, note.source)}${doc.footnoteReferences[key] ? ` <a href="#${e(doc.footnoteReferences[key])}" aria-label="Back to reference">↩</a>` : ''}</li>`).join('')}</ol></section>`);
  return out.join('\n');
}

function sizeSvg(svg, width, height) {
  return svg.replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(?:width|height|style)="[^"]*"/g, '')} width="${round(width)}" height="${round(height)}">`);
}

function textPaths(item) {
  const { run, scale } = shape(item.text, item.font, item.fontSize);
  let x = item.x;
  const paths = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const pos = run.positions[i];
    const d = glyphPath(item.font, run.glyphs[i]);
    if (d) paths.push(`<path d="${d}" transform="translate(${round(x + pos.xOffset * scale)} ${round(item.y - pos.yOffset * scale)}) scale(${scale} ${-scale})"/>`);
    x += pos.xAdvance * scale;
  }
  return `<g fill="${e(item.color || '#23313b')}"${sourceAttrs(item.source)} data-block-id="${e(item.blockId || '')}">${paths.join('')}</g>`;
}

export function renderPagedHtml(doc, layout, { checkAbort = () => {} } = {}) {
  const anchors = new Set();
  const pages = layout.pages.map(page => {
    checkAbort();
    const vectors = [], selection = [];
    for (const item of page.items) {
      checkAbort();
      for (const anchor of [item.label, item.blockId].filter(Boolean)) {
        if (!anchors.has(anchor)) { vectors.push(`<rect id="${e(anchor)}" x="${round(item.x)}" y="${round(item.y)}" width=".1" height=".1" opacity="0" pointer-events="none"/>`); anchors.add(anchor); }
      }
      if (item.type === 'text') {
        const path = textPaths(item);
        vectors.push(item.link ? `<a href="${e(safeUrl(item.link))}">${path}</a>` : path);
        selection.push(`<span${sourceAttrs(item.source)} style="left:${round(item.x)}pt;top:${round(item.y - item.fontSize)}pt;font-size:${item.fontSize}pt;width:${round(item.width)}pt;height:${round(item.height)}pt">${item.link ? `<a style="color:inherit" href="${e(safeUrl(item.link))}">${e(item.text)}</a>` : e(item.text)}</span>`);
      } else if (item.type === 'rect') vectors.push(`<rect x="${round(item.x)}" y="${round(item.y)}" width="${round(item.width)}" height="${round(item.height)}" fill="${e(item.color)}"${item.stroke ? ` stroke="${e(item.stroke)}" stroke-width=".5"` : ''}/>`);
      else if (item.type === 'line') vectors.push(`<path d="M${round(item.x)} ${round(item.y)}h${round(item.width)}" fill="none" stroke="${e(item.color)}" stroke-width=".6"/>`);
      else if (item.type === 'math' || item.type === 'svg') {
        const top = item.type === 'math' && !item.topAligned ? item.y - item.height + item.descent : item.y;
        vectors.push(`<g transform="translate(${round(item.x)} ${round(top)})"${sourceAttrs(item.source)}>${sizeSvg(item.svg, item.width, item.height)}</g>`);
      } else if (item.type === 'image') vectors.push(`<image x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" href="${e(item.dataUri)}"${sourceAttrs(item.source)}/>`);
    }
    return `<section class="page" data-page="${page.number}" aria-label="Page ${page.number}" style="width:${page.width}pt;height:${page.height}pt"><svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}" aria-hidden="true">${vectors.join('')}</svg><div class="selection" aria-hidden="true">${selection.join('')}</div></section>`;
  }).join('\n');
  const semantics = semanticBody(doc).replace(/\bid="/g, 'id="semantic-').replace(/href="#/g, 'href="#semantic-');
  return `<!doctype html><html lang="${e(doc.metadata.language || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Earlyx 0.1"><title>${e(doc.metadata.title || 'Earlyx document')}</title><style>${pageCss}@page{size:${layout.width}pt ${layout.height}pt;margin:0}</style></head><body><article class="sr-only" aria-label="Document content">${semantics}</article><main class="pages">${pages}</main></body></html>`;
}

export function renderResponsiveHtml(doc, layout) {
  const family = fontFamilies[layout.style.font]?.[0] || 'Earlyx Serif';
  const sharedStyles = `body{font-family:"${family}","Earlyx CJK","Earlyx Arabic",serif;font-size:${Math.max(14, layout.style.fontSize * 4/3)}px;line-height:${layout.style.lineHeight};color:${layout.style.color};text-align:${layout.style.align}}h1,h2,h3,h4,h5,h6{color:inherit}a{color:${layout.style.accent}}code{font-family:"Earlyx Mono",monospace}figure svg{max-width:100%;height:auto}.math-display{display:block}.math-inline{max-width:100%}.math-inline svg,.math-display svg{height:auto}`;
  return `<!doctype html><html lang="${e(doc.metadata.language || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Earlyx 0.1"><meta name="description" content="${e(doc.metadata.description || '')}"><title>${e(doc.metadata.title || 'Earlyx document')}</title><style>${webCss}${embeddedFontCss(layout)}${sharedStyles}</style></head><body><article>${semanticBody(doc)}</article></body></html>`;
}

export async function renderPdf(document, layout, { checkAbort = () => {} } = {}) {
  const pdf = new PDFDocument({ autoFirstPage: false, bufferPages: true, tagged: true, lang: document.metadata.language || 'en', displayTitle: true,
    info: { Title: document.metadata.title || 'Earlyx document', Author: document.metadata.author || '', Creator: 'Earlyx 0.1', Producer: 'Earlyx shared layout / PDFKit', CreationDate: new Date('2026-01-01T00:00:00Z'), ModDate: new Date('2026-01-01T00:00:00Z') } });
  const chunks = [];
  const finished = new Promise((resolve, reject) => { pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  for (const name of Object.keys(fontFiles)) pdf.registerFont(name, fontPath(name));
  const root = pdf.struct('Document');
  pdf.addStructure(root);
  const destinations = new Set();
  for (const page of layout.pages) {
    checkAbort();
    pdf.addPage({ size: [page.width, page.height], margin: 0 });
    let group = null, lastKey;
    for (const item of page.items) {
      for (const anchor of [item.label, item.blockId].filter(Boolean)) {
        if (!destinations.has(anchor)) { pdf.addNamedDestination(anchor, 'XYZ', item.x, page.height - item.y, null); destinations.add(anchor); }
      }
      const key = `${item.blockId}:${item.role}`;
      const artifact = item.role === 'Artifact' || ['line', 'rect'].includes(item.type);
      if (!artifact && key !== lastKey) {
        group = pdf.struct(item.role === 'Formula' ? 'Formula' : /^H[1-6]$/.test(item.role) ? item.role : item.role === 'Figure' ? 'Figure' : 'P', item.alt || item.expression ? { alt: item.alt || item.expression } : {});
        root.add(group); lastKey = key;
      }
      const draw = () => {
        if (item.type === 'text') {
          pdf.font(item.font).fontSize(item.fontSize).fillColor(item.color || '#23313b');
          pdf.text(item.text, item.x, item.y, { baseline: 'alphabetic', lineBreak: false, features: [], ...(item.link ? item.link.startsWith('#') ? { goTo: item.link.slice(1) } : { link: safeUrl(item.link) } : {}) });
        } else if (item.type === 'rect') {
          pdf.save().rect(item.x, item.y, item.width, item.height).fillColor(item.color || '#ffffff');
          if (item.stroke) pdf.strokeColor(item.stroke).lineWidth(0.5).fillAndStroke(); else pdf.fill();
          pdf.restore();
        } else if (item.type === 'line') pdf.save().strokeColor(item.color || '#8ca0ab').lineWidth(0.6).moveTo(item.x, item.y).lineTo(item.x + item.width, item.y + item.height).stroke().restore();
        else if (item.type === 'math' || item.type === 'svg') {
          const top = item.type === 'math' && !item.topAligned ? item.y - item.height + item.descent : item.y;
          SVGtoPDF(pdf, sizeSvg(item.svg, item.width, item.height), item.x, top, { width: item.width, height: item.height, assumePt: true,
            fontCallback: () => 'serif', warningCallback: message => { if (!message.includes('unsupported')) { /* SVG subset diagnostics are generated at loading. */ } } });
        } else if (item.type === 'image') pdf.image(Buffer.from(item.dataUri.split(',')[1], 'base64'), item.x, item.y, { width: item.width, height: item.height });
      };
      if (artifact) { pdf.markContent('Artifact'); draw(); pdf.endMarkedContent(); }
      else { const content = pdf.markStructureContent('Span', item.type === 'math' ? { actual: item.expression } : {}); group.add(content); draw(); pdf.endMarkedContent(); }
    }
  }
  root.end();
  pdf.end();
  return finished;
}
