import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { chooseFont, shape, glyphPath } from './fonts.js';
import { round } from './util.js';

// Resolve SVG labels once, using the same bundled fonts as the document. Browser
// fallback fonts otherwise make figures differ from their PDF counterparts.
export function normalizeSvgText(svg) {
  const document = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message); } }).parseFromString(svg, 'image/svg+xml');
  const inherited = (node, name, fallback) => {
    for (let current = node; current?.nodeType === 1; current = current.parentNode) {
      if (current.hasAttribute(name)) return current.getAttribute(name);
      const style = current.getAttribute('style') || '';
      const value = style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
      if (value) return value[1].trim();
    }
    return fallback;
  };
  for (const text of Array.from(document.getElementsByTagName('text'))) {
    if (text.getElementsByTagName('tspan').length) throw new Error('SVG text spans are not supported yet; convert complex labels to paths.');
    const size = Number.parseFloat(inherited(text, 'font-size', '16'));
    const x = Number.parseFloat(text.getAttribute('x') || 0) + Number.parseFloat(text.getAttribute('dx') || 0);
    const y = Number.parseFloat(text.getAttribute('y') || 0) + Number.parseFloat(text.getAttribute('dy') || 0);
    if (![size, x, y].every(Number.isFinite) || size <= 0 || size > 1000) throw new Error('SVG text coordinates and font size must be finite.');
    const weight = inherited(text, 'font-weight', 'normal');
    const preferred = weight === 'bold' || Number(weight) >= 600 ? 'bold' : /mono|code/i.test(inherited(text, 'font-family', '')) ? 'mono' : 'serif';
    const value = text.textContent;
    const font = chooseFont(value, preferred);
    const { run, scale, width } = shape(value, font, size);
    const anchor = inherited(text, 'text-anchor', 'start');
    let cursor = x - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    for (const name of ['fill', 'stroke', 'stroke-width', 'opacity', 'transform', 'class', 'id']) if (text.hasAttribute(name)) group.setAttribute(name, text.getAttribute(name));
    for (let i = 0; i < run.glyphs.length; i++) {
      const pos = run.positions[i];
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', glyphPath(font, run.glyphs[i]));
      path.setAttribute('transform', `translate(${round(cursor + pos.xOffset * scale)} ${round(y - pos.yOffset * scale)}) scale(${scale} ${-scale})`);
      group.appendChild(path);
      cursor += pos.xAdvance * scale;
    }
    text.parentNode.replaceChild(group, text);
  }
  return new XMLSerializer().serializeToString(document);
}
