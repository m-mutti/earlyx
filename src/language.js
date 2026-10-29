/** Earlyx's declarative, source-mapped document language. No eval or I/O. */
const DEFAULT_PAGE = Object.freeze({ size: 'a4', margin: 48 });
const DEFAULT_STYLE = Object.freeze({ font: 'serif', fontSize: 11, lineHeight: 1.45, color: '#263238' });
const MAX_SOURCE = 2_000_000;
const MAX_EXPANSION = 16;

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}

function splitArguments(input, separator = ',') {
  const parts = [];
  let quote = '', escaped = false, depth = 0, start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    if (depth < 0) throw new Error('Unexpected closing bracket in arguments.');
    if (char === separator && depth === 0) { parts.push(input.slice(start, i).trim()); start = i + 1; }
  }
  if (quote) throw new Error('Close the quoted string.');
  if (depth !== 0) throw new Error('Close the argument brackets.');
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function parseValue(input) {
  const value = input.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value);
  if (/^'(?:[^'\\]|\\.)*'$/.test(value)) {
    return value.slice(1, -1).replace(/\\([\\'nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
  }
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('Numbers must be finite.');
    return number;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value.startsWith('[') && value.endsWith(']')) return splitArguments(value.slice(1, -1)).map(parseValue);
  throw new Error(`Expected quoted text, a number, a boolean, or an array; received ${value.slice(0, 50) || 'an empty value'}.`);
}

/** Parse declarative directive arguments without executing source text. */
export function parseArguments(input) {
  const positional = [], named = {};
  for (const part of splitArguments(input)) {
    const match = /^([a-zA-Z][\w-]*)\s*:\s*([\s\S]+)$/.exec(part);
    if (match) {
      if (Object.hasOwn(named, match[1])) throw new Error(`Argument ${match[1]} is repeated.`);
      named[match[1]] = parseValue(match[2]);
    } else positional.push(parseValue(part));
  }
  return { positional, named };
}

function matchingParen(text, opening) {
  let depth = 0, quote = '', escaped = false;
  for (let i = opening; i < text.length; i++) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Inline content retains semantics; renderers decide how it looks. */
export function parseInline(input = '') {
  const text = String(input), nodes = [];
  let buffer = '';
  const flush = () => { if (buffer) { nodes.push({ type: 'text', text: buffer }); buffer = ''; } };
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\*$`\[\]@_]/.test(text[i + 1] || '')) {
      buffer += text[i + 1]; i += 2; continue;
    }
    const directive = /^@(ref|cite)\(/.exec(text.slice(i));
    if (directive) {
      const opening = i + directive[0].length - 1, closing = matchingParen(text, opening);
      if (closing >= 0) {
        try {
          const args = parseArguments(text.slice(opening + 1, closing));
          const target = args.positional[0];
          if (typeof target === 'string' && target) {
            flush(); nodes.push({ type: directive[1], target, key: target, text: args.named.text || '' }); i = closing + 1; continue;
          }
        } catch { /* Incomplete inline expressions stay readable during typing. */ }
      }
    }
    const footnote = /^\[\^([\w.-]+)\]/.exec(text.slice(i));
    if (footnote) { flush(); nodes.push({ type: 'footnote', key: footnote[1], target: footnote[1] }); i += footnote[0].length; continue; }
    const link = /^\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"([^"\n]*)")?\)/.exec(text.slice(i));
    if (link) {
      const target = link[2];
      if (!/^(?:javascript|data|vbscript):/i.test(target)) {
        flush(); nodes.push({ type: 'link', text: link[1], target, title: link[3] || '', children: parseInline(link[1]) }); i += link[0].length; continue;
      }
    }
    let matched = false;
    for (const [delimiter, type] of [['**', 'strong'], ['__', 'strong'], ['`', 'code'], ['$', 'math'], ['*', 'emphasis'], ['_', 'emphasis']]) {
      if (!text.startsWith(delimiter, i)) continue;
      if (delimiter === '_' && /[\p{L}\p{N}]/u.test(text[i - 1] || '')) continue;
      let end = i + delimiter.length;
      while ((end = text.indexOf(delimiter, end)) >= 0 && text[end - 1] === '\\') end += delimiter.length;
      if (end > i + delimiter.length) {
        const content = text.slice(i + delimiter.length, end);
        flush(); nodes.push({ type, text: content, ...(['strong', 'emphasis'].includes(type) ? { children: parseInline(content) } : {}) });
        i = end + delimiter.length; matched = true; break;
      }
    }
    if (!matched) buffer += text[i++];
  }
  flush();
  return nodes;
}

function rowsFromLine(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function sourceLines(source) {
  const lines = [];
  let offset = 0;
  for (const raw of source.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text, start: offset, end: offset + text.length });
    offset += raw.length + 1;
  }
  return lines;
}

/** Parse a complete document. File access and dependency resolution belong to the compiler. */
export function parse(input, options = {}) {
  const filename = options.filename || '<document>', source = String(input ?? '');
  const lines = sourceLines(source), blocks = [], diagnostics = [], dependencies = [];
  const metadata = {}, page = { ...DEFAULT_PAGE }, style = { ...DEFAULT_STYLE }, components = { ...(options.components || {}) }, footnotes = Object.create(null);
  const expansion = options.expansion || [], ids = new Map();
  const expansionBudget = options.expansionBudget || { characters: 0, calls: 0 };
  const location = (start, end = start) => ({ file: filename, line: start + 1, column: (lines[start]?.text.search(/\S/) ?? 0) + 1, start: lines[start]?.start ?? 0, end: lines[end]?.end ?? source.length });
  const diagnostic = (code, message, start, severity = 'error') => diagnostics.push({ code, message, severity, source: location(start), line: start + 1, column: location(start).column, file: filename });
  const add = (block, start, end = start) => {
    const fingerprint = `${block.type}:${JSON.stringify(block, (key, value) => key === 'source' || key === 'expansion' ? undefined : value)}`, key = hash(fingerprint), count = ids.get(key) || 0;
    ids.set(key, count + 1);
    const node = { ...block, id: `${block.type}-${key}${count ? `-${count}` : ''}`, source: location(start, end) };
    blocks.push(node); return node;
  };
  const dependency = (path, kind, line) => {
    if (typeof path !== 'string' || !path.trim()) throw new Error(`${kind} needs a non-empty quoted file path.`);
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.includes('\0')) throw new Error('Dependencies must be local project files.');
    dependencies.push({ path, kind, source: location(line) }); return path;
  };
  const result = () => ({ metadata, page, style, blocks, diagnostics, dependencies, components, footnotes });
  if (source.length > MAX_SOURCE) { diagnostic('source-size', `Document exceeds the ${MAX_SOURCE.toLocaleString()} character limit. Split it into included files.`, 0); return result(); }
  expansionBudget.characters += source.length;
  expansionBudget.calls++;
  if (expansionBudget.characters > 10_000_000 || expansionBudget.calls > 128) {
    diagnostic('component-budget', 'Component expansion exceeds the project limit. Reduce repeated or nested template calls.', 0);
    return result();
  }
  const structural = line => /^\s*(?:#{1,6}\s|```|~~~|\$\$|\||(?:[-+*]|\d+[.)])\s|@(?:[a-zA-Z][\w-]*)(?:\s|\()|\[\^[\w.-]+\]:)/.test(line);

  for (let i = 0; i < lines.length;) {
    if (blocks.length >= 20_000) { diagnostic('block-limit', 'Document exceeds 20,000 blocks. Split or reduce the generated content.', i); break; }
    const raw = lines[i].text, text = raw.trim(), start = i;
    if (!text || text.startsWith('//')) { i++; continue; }
    let match;
    if ((match = /^@component\s+([a-zA-Z][\w-]*)\s*\(([^)]*)\)\s*\{\s*$/.exec(text))) {
      const name = match[1], parameters = match[2].split(',').map(value => value.trim()).filter(Boolean);
      if (parameters.some(value => !/^[a-zA-Z][\w-]*$/.test(value)) || new Set(parameters).size !== parameters.length) diagnostic('component-parameters', 'Component parameters must be unique names.', i);
      const content = []; let depth = 1;
      i++;
      for (; i < lines.length; i++) {
        const current = lines[i].text.trim();
        if (/^@component\b.*\{\s*$/.test(current)) depth++;
        if (current === '}' && --depth === 0) break;
        content.push(lines[i].text);
      }
      if (depth > 0) diagnostic('unclosed-component', `Close component ${name} with a line containing }.`, start);
      if (Object.hasOwn(components, name)) diagnostic('duplicate-component', `Component ${name} is already defined.`, start);
      components[name] = { name, parameters, body: content.join('\n'), source: location(start, Math.min(i, lines.length - 1)) };
      i++; continue;
    }
    if ((match = /^@use\s+([a-zA-Z][\w-]*)\s*\((.*)\)\s*$/.exec(text))) {
      const name = match[1], component = Object.hasOwn(components, name) ? components[name] : null;
      if (!component) { diagnostic('unknown-component', `Define component ${name} before using it.`, i); i++; continue; }
      if (expansion.length >= MAX_EXPANSION || expansion.includes(name)) { diagnostic('component-recursion', `Recursive component expansion: ${[...expansion, name].join(' → ')}.`, i); i++; continue; }
      try {
        const args = parseArguments(match[2]), values = {};
        component.parameters.forEach((parameter, index) => { values[parameter] = args.named[parameter] ?? args.positional[index]; });
        for (const parameter of component.parameters) if (values[parameter] === undefined) throw new Error(`Supply component argument ${parameter}.`);
        const unknown = Object.keys(args.named).filter(key => !component.parameters.includes(key));
        if (unknown.length) throw new Error(`Unknown component argument ${unknown[0]}.`);
        let expandedLength = component.body.length;
        const body = component.body.replace(/\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g, (placeholder, key) => {
          if (!Object.hasOwn(values, key)) throw new Error(`Unknown component parameter ${key}.`);
          const replacement = String(values[key]);
          expandedLength += replacement.length - placeholder.length;
          if (expandedLength > MAX_SOURCE) throw new Error('Component output exceeds the document size limit.');
          return replacement;
        });
        const expanded = parse(body, { filename, components, expansion: [...expansion, name], expansionBudget });
        for (const node of expanded.blocks) {
          const { id, source: definitionSource, ...content } = node;
          const added = add(content, i); added.expansion = { component: name, definition: component.source, inner: definitionSource };
        }
        dependencies.push(...expanded.dependencies.map(item => ({ ...item, source: location(i) })));
        diagnostics.push(...expanded.diagnostics.map(item => ({ ...item, source: location(i), line: i + 1 })));
        Object.assign(footnotes, expanded.footnotes);
      } catch (error) { diagnostic('component-arguments', error.message, i); }
      i++; continue;
    }
    if ((match = /^@([a-zA-Z][\w-]*)\s*(.*)$/.exec(text)) && !['ref', 'cite'].includes(match[1])) {
      const name = match[1];
      try {
        let args;
        if (match[2].startsWith('(')) {
          const closing = matchingParen(match[2], 0);
          if (closing < 0) throw new Error(`Close @${name}(...) with ).`);
          if (match[2].slice(closing + 1).trim()) throw new Error(`Unexpected text after @${name}(...).`);
          args = parseArguments(match[2].slice(1, closing));
        } else args = parseArguments(match[2]);
        const value = args.positional[0], attr = args.named;
        if (['title', 'author', 'description', 'language', 'date'].includes(name)) {
          if (typeof value !== 'string') throw new Error(`@${name} needs quoted text.`);
          metadata[name] = value;
        } else if (name === 'page') {
          const allowed = ['size', 'margin', 'width', 'height'];
          for (const [key, value] of Object.entries(attr)) {
            if (!allowed.includes(key)) throw new Error(`Unknown page setting ${key}.`);
            if (key === 'size' && !['a4', 'letter', 'a5'].includes(value)) throw new Error('Page size must be "a4", "letter", or "a5".');
            if (key !== 'size' && (typeof value !== 'number' || value < (key === 'margin' ? 0 : 72) || value > 2000)) throw new Error(`Page ${key} must be a number between ${key === 'margin' ? 0 : 72} and 2000 points.`);
            page[key] = value;
          }
        } else if (name === 'style') {
          for (const [key, value] of Object.entries(attr)) {
            if (!['font', 'fontSize', 'lineHeight', 'color', 'accent', 'align'].includes(key)) throw new Error(`Unknown style setting ${key}.`);
            if (['fontSize', 'lineHeight'].includes(key) && (typeof value !== 'number' || value <= 0 || value > (key === 'fontSize' ? 200 : 5))) throw new Error(`Invalid ${key}. Use a positive number within the supported range.`);
            if (['color', 'accent'].includes(key) && !/^#[\da-f]{6}$/i.test(value)) throw new Error(`${key} must be a six-digit hex color, such as "#263238".`);
            if (key === 'font' && !['serif', 'sans', 'mono'].includes(value)) throw new Error('font must be "serif", "sans", or "mono".');
            if (key === 'align' && !['left', 'center', 'right', 'justify'].includes(value)) throw new Error('align must be "left", "center", "right", or "justify".');
            style[key] = value;
          }
        } else if (name === 'label') {
          if (typeof value !== 'string' || !/^[\w.-]+$/.test(value)) throw new Error('Labels use letters, numbers, dots, underscores, and hyphens.');
          if (!blocks.length) throw new Error('Place @label("id") after the block it labels.');
          if (blocks.some(block => block.label === value)) throw new Error(`Label ${value} is already used.`);
          blocks.at(-1).label = value;
        } else if (name === 'figure') {
          const path = dependency(value, 'figure', i);
          add({ type: 'figure', path, src: path, caption: String(attr.caption || ''), alt: String(attr.alt || attr.caption || ''), label: attr.id || null, width: attr.width, inline: parseInline(attr.caption || '') }, i);
        } else if (name === 'include' || name === 'bibliography') {
          const path = dependency(value, name, i);
          add({ type: name, path, title: attr.title || (name === 'bibliography' ? 'References' : '') }, i);
        } else if (name === 'break' || name === 'pagebreak') add({ type: 'pagebreak' }, i);
        else if (name === 'toc') add({ type: 'toc', title: attr.title || 'Contents' }, i);
        else if (name === 'table') {
          let end = i + 1; while (end < lines.length && !lines[end].text.trim()) end++;
          if (!lines[end]?.text.trim().startsWith('|')) throw new Error('Place pipe-separated table rows after @table(...).');
          const rows = [];
          while (end < lines.length && lines[end].text.trim().startsWith('|')) rows.push(rowsFromLine(lines[end++].text));
          const headers = rows.shift() || [];
          if (rows[0]?.every(cell => /^:?-{3,}:?$/.test(cell))) rows.shift();
          if (rows.some(row => row.length !== headers.length)) diagnostic('table-columns', 'Each table row must have the same number of cells as the header.', i);
          add({ type: 'table', headers, rows, headerInlines: headers.map(parseInline), rowInlines: rows.map(row => row.map(parseInline)), caption: String(attr.caption || ''), label: attr.id || null, inline: parseInline(attr.caption || '') }, i, end - 1);
          i = end; continue;
        } else throw new Error(`Unknown directive @${name}.`);
      } catch (error) { diagnostic('directive', error.message, i); }
      i++; continue;
    }
    if ((match = /^\[\^([\w.-]+)\]:\s*(.*)$/.exec(text))) {
      if (Object.hasOwn(footnotes, match[1])) diagnostic('duplicate-footnote', `Footnote ${match[1]} is already defined.`, i);
      footnotes[match[1]] = { text: match[2], inline: parseInline(match[2]), source: location(i) };
      i++; continue;
    }
    if ((match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text))) {
      add({ type: 'heading', level: match[1].length, text: match[2], inline: parseInline(match[2]) }, i); i++; continue;
    }
    if ((match = /^(```+|~~~+)\s*([\w+-]*)\s*$/.exec(text))) {
      const fence = match[1], language = match[2], content = []; i++;
      while (i < lines.length && !lines[i].text.trim().startsWith(fence)) content.push(lines[i++].text);
      if (i === lines.length) diagnostic('unclosed-code', `Close the code block with ${fence}.`, start, 'warning');
      add({ type: 'code', language, text: content.join('\n') }, start, Math.min(i, lines.length - 1)); i++; continue;
    }
    if (text.startsWith('$$')) {
      const content = []; let opening = text.slice(2), closed = false;
      const sameLineEnd = opening.indexOf('$$');
      if (sameLineEnd >= 0) { content.push(opening.slice(0, sameLineEnd)); closed = true; }
      else {
        if (opening) content.push(opening); i++;
        while (i < lines.length) {
          const closing = lines[i].text.indexOf('$$');
          if (closing >= 0) { content.push(lines[i].text.slice(0, closing)); closed = true; break; }
          content.push(lines[i++].text);
        }
      }
      if (!closed) diagnostic('unclosed-math', 'Close the display equation with $$.', start, 'warning');
      add({ type: 'math', text: content.join('\n').trim(), display: true }, start, Math.min(i, lines.length - 1)); i++; continue;
    }
    if ((match = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(raw))) {
      const ordered = /^\d/.test(match[2]), items = [], first = Number.parseInt(match[2], 10) || 1;
      while (i < lines.length) {
        const item = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(lines[i].text);
        if (!item || /^\d/.test(item[2]) !== ordered) break;
        items.push({ text: item[3], inline: parseInline(item[3]), level: Math.floor(item[1].replace(/\t/g, '  ').length / 2), source: location(i) }); i++;
      }
      add({ type: 'list', ordered, start: first, items }, start, i - 1); continue;
    }
    if (text.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].text.trim().startsWith('|')) rows.push(rowsFromLine(lines[i++].text));
      const headers = rows.shift() || [];
      if (rows[0]?.every(cell => /^:?-{3,}:?$/.test(cell))) rows.shift();
      if (rows.some(row => row.length !== headers.length)) diagnostic('table-columns', 'Each table row must have the same number of cells as the header.', start);
      add({ type: 'table', headers, rows, headerInlines: headers.map(parseInline), rowInlines: rows.map(row => row.map(parseInline)), caption: '', label: null }, start, i - 1); continue;
    }
    const content = [text]; i++;
    while (i < lines.length && lines[i].text.trim() && !lines[i].text.trim().startsWith('//') && !structural(lines[i].text)) content.push(lines[i++].text.trim());
    const paragraph = content.join(' ');
    add({ type: 'paragraph', text: paragraph, inline: parseInline(paragraph) }, start, i - 1);
  }
  const labels = new Set();
  for (const block of blocks) if (block.label) {
    if (labels.has(block.label)) diagnostics.push({ code: 'duplicate-label', severity: 'error', message: `Label ${block.label} is already used.`, source: block.source, line: block.source.line, column: block.source.column, file: filename });
    labels.add(block.label);
  }
  return result();
}

export const languageDefaults = Object.freeze({ page: DEFAULT_PAGE, style: DEFAULT_STYLE });
