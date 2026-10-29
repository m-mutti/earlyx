import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import { SerializedMmlVisitor } from 'mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js';
import { STATE } from 'mathjax-full/js/core/MathItem.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const engine = mathjax.document('', { InputJax: new TeX({ packages: ['base', 'ams'], maxBuffer: 10000 }), OutputJax: new SVG({ fontCache: 'none' }) });
const cache = new Map();
export function renderMath(expression, fontSize = 11, display = false) {
  const key = JSON.stringify([expression, fontSize, display]);
  if (cache.has(key)) return cache.get(key);
  const node = engine.convert(expression, { display, em: fontSize, ex: fontSize / 2, containerWidth: 480 });
  const outer = adaptor.outerHTML(node);
  const svg = outer.slice(outer.indexOf('<svg'), outer.lastIndexOf('</svg>') + 6);
  const viewBox = svg.match(/viewBox="([^"]+)"/);
  const [, , w, h] = viewBox ? viewBox[1].split(/\s+/).map(Number) : [0, 0, 1000, 1000];
  const width = w / 1000 * fontSize;
  const height = h / 1000 * fontSize;
  const depthEx = Number(svg.match(/vertical-align:\s*(-?[\d.]+)ex/)?.[1] || 0);
  const mathml = new SerializedMmlVisitor().visitTree(engine.convert(expression, { display, end: STATE.COMPILED }));
  const result = { svg, mathml, width, height, descent: Math.max(0, -depthEx * fontSize / 2), expression,
    error: /data-mml-node="merror"/.test(svg) };
  cache.set(key, result);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return result;
}

