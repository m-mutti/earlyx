import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fontFiles = {
  serif: 'SourceSerif4-Regular.otf', bold: 'SourceSerif4-Bold.otf', italic: 'SourceSerif4-It.otf',
  mono: 'SourceCodePro-Regular.otf', arabic: 'NotoSansArabic.ttf', cjk: 'NotoSansKR.ttf',
  sans: 'SourceSans3-Regular.otf', sansBold: 'SourceSans3-Bold.otf', sansItalic: 'SourceSans3-It.otf',
};
const fonts = new Map();
const outlines = new Map();
const shapes = new Map();
export function fontPath(name = 'serif') { return path.join(projectRoot, 'assets/fonts', fontFiles[name] || fontFiles.serif); }
export function getFont(name = 'serif') {
  if (!fonts.has(name)) {
    let font = fontkit.create(fs.readFileSync(fontPath(name)));
    if (font.variationAxes && Object.keys(font.variationAxes).length) font = font.getVariation({ wght: 400 });
    fonts.set(name, font);
  }
  return fonts.get(name);
}
export function chooseFont(text, preferred = 'serif') {
  if (/[\u0600-\u06ff\u0750-\u077f]/u.test(text)) return 'arabic';
  if (/[\u3000-\u9fff\uac00-\ud7af\u3040-\u30ff]/u.test(text)) return 'cjk';
  return fontFiles[preferred] ? preferred : 'serif';
}
export function shape(text, fontName = 'serif', fontSize = 11) {
  const key = `${fontName}:${fontSize}:${text}`;
  if (shapes.has(key)) return shapes.get(key);
  const font = getFont(fontName);
  const run = font.layout(text, []);
  const scale = fontSize / font.unitsPerEm;
  const value = { run, scale, width: run.positions.reduce((n, p) => n + p.xAdvance * scale, 0),
    ascent: font.ascent * scale, descent: -font.descent * scale };
  shapes.set(key, value);
  if (shapes.size > 20000) shapes.delete(shapes.keys().next().value);
  return value;
}
export function glyphPath(fontName, glyph) {
  const key = `${fontName}:${glyph.id}`;
  if (!outlines.has(key)) outlines.set(key, glyph.path.toSVG());
  return outlines.get(key);
}

