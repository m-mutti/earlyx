import fs from 'node:fs';
import path from 'node:path';
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const round = n => Math.round(n * 1000) / 1000;
export function safePath(root, file, relativeTo = root) {
  const rootReal = fs.realpathSync(root);
  const resolved = fs.realpathSync(path.resolve(relativeTo, file));
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) throw new Error(`File must remain inside the project: ${file}`);
  return resolved;
}
export function safeUrl(value) {
  const url = String(value || '');
  return /^(?:https?:|mailto:|#)/i.test(url) ? url : '#';
}
export function sanitizeSvg(svg) {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg\b/i.test(svg)) throw new Error('Expected a standalone SVG image');
  if (/<(?:script|foreignObject|iframe|image|style|animate\w*|set)\b|\bon\w+\s*=|<!DOCTYPE|<!ENTITY|(?:href\s*=\s*["']\s*(?!#))|url\(\s*(?!#)/i.test(svg)) throw new Error('SVG images must contain static, self-contained vector shapes');
  return svg.replace(/<\?xml[^>]*>/g, '');
}
