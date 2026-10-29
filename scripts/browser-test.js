#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'browser');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/private/tmp/earlyx-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/private/tmp/earlyx-browsers';

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Preview server exited (${child.exitCode}).`);
    try { const response = await fetch(url); if (response.ok) return; } catch { /* Startup is still in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Preview server did not become ready at ${url}.`);
}

async function main() {
  await mkdir(output, { recursive: true });
  const { chromium } = await import('playwright');
  const url = process.env.EARLYX_URL || 'http://127.0.0.1:4318';
  const child = process.env.EARLYX_URL ? null : spawn(process.execPath, [path.join(root, 'bin', 'earlyx.js'), 'serve', '--port', '4318'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child?.stdout.on('data', chunk => { logs += chunk; });
  child?.stderr.on('data', chunk => { logs += chunk; });
  let browser;
  const checks = [];
  const errors = [];
  const started = performance.now();
  try {
    await waitForServer(url, child);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const source = page.getByTestId('source-input');
    const status = page.getByTestId('compile-status');
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('[data-testid="compile-status"]')?.dataset.state), { timeout: 30_000 });
    assert.ok(await source.inputValue());
    assert.notEqual(await page.getByTestId('stats-total').innerText(), '—');
    assert.ok(await page.getByTestId('example-select').locator('option').count() >= 3);
    checks.push({ name: 'initial examples and measured compilation', passed: true });

    const fixture = '@title "Browser verification"\n\n# A live document\n\nA deliberate edit should appear in the preview.\n\n## A second section\n\nStable content remains available for reuse.\n';
    const setSource = async value => {
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/compile') && response.request().postDataJSON()?.source === value);
      await source.fill(value);
      const response = await responsePromise;
      assert.equal(response.status(), 200, await response.text());
      const result = await response.json();
      await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('[data-testid="compile-status"]')?.dataset.state));
      return result;
    };
    const result = await setSource(fixture);
    assert.ok(result.stats.totalMs >= 0);
    assert.ok(result.pdfUrl);
    await page.frameLocator('[data-testid="preview-frame"]').locator('.page > svg').first().waitFor();
    checks.push({ name: 'real source edit compiles through server', passed: true, stats: result.stats });

    await page.getByTestId('web-tab').click();
    await page.frameLocator('[data-testid="preview-frame"]').getByRole('heading', { name: 'A live document', exact: true }).waitFor();
    assert.equal(await page.getByTestId('web-tab').getAttribute('aria-selected'), 'true');
    checks.push({ name: 'responsive HTML has semantic headings', passed: true });

    const htmlDownloadPromise = page.waitForEvent('download');
    await page.locator('#download-html').click();
    const htmlDownload = await htmlDownloadPromise;
    await htmlDownload.saveAs(path.join(output, 'download.web.html'));
    const html = await readFile(path.join(output, 'download.web.html'), 'utf8');
    assert.ok(html.includes('A live document'));
    assert.ok(htmlDownload.suggestedFilename().endsWith('.web.html'));
    checks.push({ name: 'responsive HTML download contains current source', passed: true });

    const pdfDownloadPromise = page.waitForEvent('download');
    await page.locator('#download-pdf').click();
    const pdfDownload = await pdfDownloadPromise;
    await pdfDownload.saveAs(path.join(output, 'download.pdf'));
    const pdf = await readFile(path.join(output, 'download.pdf'));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    checks.push({ name: 'PDF download is an actual PDF', passed: true, bytes: pdf.length });

    await page.getByTestId('pdf-tab').click();
    assert.ok((await page.getByTestId('preview-frame').getAttribute('src'))?.includes('.pdf'));
    const pdfResponse = await page.request.get(new URL(result.pdfUrl, url).href);
    assert.equal(pdfResponse.status(), 200);
    assert.ok(pdfResponse.headers()['content-type']?.includes('application/pdf'));
    checks.push({ name: 'PDF mode loads the compiled artifact', passed: true });

    await page.getByTestId('paged-tab').click();
    const mapping = page.frameLocator('[data-testid="preview-frame"]').locator('.selection span[data-source-start]').first();
    await mapping.waitFor();
    const mappedStart = Number(await mapping.getAttribute('data-source-start'));
    await mapping.click({ force: true });
    const selection = await source.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd }));
    assert.equal(selection.start, mappedStart);
    assert.ok(selection.end >= selection.start);
    checks.push({ name: 'preview click selects mapped source', passed: true });

    // Hold one response after the server has completed it, edit again, and allow
    // the stale response to arrive last. This exercises the actual UI race gate.
    let releaseOld;
    let oldRequested;
    const oldRequestArrived = new Promise(resolve => { oldRequested = resolve; });
    const oldResponseGate = new Promise(resolve => { releaseOld = resolve; });
    await page.route('**/api/compile', async route => {
      const body = route.request().postDataJSON();
      if (body.source?.includes('STALE_REVISION')) {
        const response = await route.fetch();
        oldRequested();
        await oldResponseGate;
        try { await route.fulfill({ response }); } catch { /* Aborted requests are expected. */ }
      } else await route.continue();
    });
    await source.fill('# STALE_REVISION\n\nAn obsolete edit.\n');
    await oldRequestArrived;
    const current = '# CURRENT_REVISION\n\nOnly the latest edit should win.\n';
    await setSource(current);
    releaseOld();
    await page.getByTestId('web-tab').click();
    await page.frameLocator('[data-testid="preview-frame"]').getByRole('heading', { name: 'CURRENT_REVISION', exact: true }).waitFor();
    assert.ok(!(await page.frameLocator('[data-testid="preview-frame"]').locator('body').innerText()).includes('STALE_REVISION'));
    await page.unroute('**/api/compile');
    checks.push({ name: 'stale compile response cannot replace current preview', passed: true });

    await setSource('@style(fontSize: -2)\n\n# Recoverable source\n\nA valid paragraph.\n');
    await page.getByTestId('diagnostic-list').locator('li').first().waitFor();
    assert.equal(await status.getAttribute('data-state'), 'error');
    await setSource(fixture);
    assert.equal(await status.getAttribute('data-state'), 'ready');
    checks.push({ name: 'invalid source has diagnostics and editing recovers', passed: true });

    await page.getByTestId('paged-tab').click();
    await page.frameLocator('[data-testid="preview-frame"]').locator('.page > svg').first().waitFor();
    await page.screenshot({ path: path.join(output, 'desktop-editor.png'), fullPage: true });
    const parity = await visualParity(page, result, output);
    checks.push({ name: 'PDF / paged HTML first-page raster comparison', passed: true, ...parity });
    const examplesResponse = await page.request.get(`${url}/api/examples`);
    const examplesPayload = await examplesResponse.json();
    const showcase = (Array.isArray(examplesPayload) ? examplesPayload : examplesPayload.examples).find(example => example.filename.endsWith('showcase.ex'));
    assert.ok(showcase, 'showcase example is available for full-feature rendering verification');
    const showcaseResponse = await page.request.post(`${url}/api/compile`, { data: { source: showcase.source, filename: showcase.filename, revision: 10000 } });
    assert.equal(showcaseResponse.status(), 200);
    const showcaseResult = await showcaseResponse.json();
    assert.ok(!showcaseResult.diagnostics.some(item => item.severity === 'error'));
    const semantics = [];
    for (const [mode, html] of [['paged', showcaseResult.html], ['responsive', showcaseResult.webHtml]]) {
      const semanticPage = await context.newPage();
      await semanticPage.setContent(html);
      const audit = await semanticPage.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
        const unresolved = [...document.querySelectorAll('a[href^="#"]')].map(anchor => anchor.getAttribute('href')).filter(href => href.length > 1 && !document.getElementById(decodeURIComponent(href.slice(1))));
        const math = document.querySelectorAll('math').length;
        const headers = [...document.querySelectorAll('th')].every(header => header.getAttribute('scope') === 'col');
        return { duplicates, unresolved: [...new Set(unresolved)], math, tableHeadersHaveScope: headers };
      });
      assert.deepEqual(audit.duplicates, [], `${mode}: document ids must be unique`);
      assert.deepEqual(audit.unresolved, [], `${mode}: all internal links must resolve`);
      assert.ok(audit.math > 0, `${mode}: equations retain MathML semantics`);
      assert.ok(audit.tableHeadersHaveScope, `${mode}: table headers have column scope`);
      if (mode === 'paged') {
        const link = semanticPage.locator('.selection a[href="#outputs"]').first();
        await link.click();
        assert.equal(await semanticPage.evaluate(() => location.hash), '#outputs');
      }
      semantics.push({ mode, ...audit });
      await semanticPage.close();
    }
    checks.push({ name: 'HTML ids, references, MathML, and table semantics are consistent', passed: true, modes: semantics });
    const showcasePages = [];
    for (let index = 0; index < showcaseResult.stats.pages; index++) {
      const directory = path.join(output, `showcase-page-${index + 1}`);
      await mkdir(directory, { recursive: true });
      showcasePages.push({ number: index + 1, ...await visualParity(page, showcaseResult, directory, index) });
    }
    checks.push({ name: 'all showcase pages match across PDF and paged HTML', passed: true, pages: showcasePages });
    const mobilePublication = await context.newPage();
    await mobilePublication.setViewportSize({ width: 390, height: 844 });
    await mobilePublication.setContent(showcaseResult.webHtml);
    assert.ok(await mobilePublication.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'full-feature responsive publication must fit mobile width');
    await mobilePublication.screenshot({ path: path.join(output, 'showcase-mobile.png'), fullPage: true });
    await mobilePublication.close();
    checks.push({ name: 'full-feature responsive publication fits mobile width', passed: true });

    await page.getByTestId('web-tab').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByTestId('pdf-tab').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getByTestId('paged-tab').getAttribute('aria-selected'), 'true');
    checks.push({ name: 'preview tabs support keyboard navigation', passed: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('web-tab').click();
    await page.frameLocator('[data-testid="preview-frame"]').getByRole('heading', { name: 'A live document', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'editor must not overflow horizontally');
    assert.ok(await page.frameLocator('[data-testid="preview-frame"]').locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'responsive output must fit its narrow frame');
    await page.screenshot({ path: path.join(output, 'mobile-editor.png'), fullPage: true });
    checks.push({ name: 'mobile editor and responsive document fit viewport', passed: true });
    await page.getByTestId('paged-tab').click();
    const copied = await page.frameLocator('[data-testid="preview-frame"]').locator('.selection').first().evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    assert.ok(copied.includes('A deliberate edit should appear in the preview.'), 'selection text retains word spaces');
    checks.push({ name: 'paged text selection retains spaces between words', passed: true });

    assert.deepEqual(errors, [], 'browser page errors');
    const report = { passed: true, capturedAt: new Date().toISOString(), totalMs: Math.round(performance.now() - started), browser: browser.version(), checks, consoleErrors: errors, artifacts: ['desktop-editor.png', 'mobile-editor.png', 'showcase-mobile.png', 'paged-first-page.png', 'pdf-first-page.png', 'raster-difference.png', 'download.web.html', 'download.pdf'] };
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(output, 'index.html'), browserReportHtml(report));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(path.join(output, 'failure.json'), JSON.stringify({ capturedAt: new Date().toISOString(), checks, errors, error: error.stack, serverLogs: logs }, null, 2));
    throw error;
  } finally {
    await browser?.close();
    child?.kill('SIGTERM');
  }
}

function browserReportHtml(report) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const showcase = report.checks.find(check => check.name === 'all showcase pages match across PDF and paged HTML');
  const pageViews = (showcase?.pages || []).map(item => `<section><h2>Showcase · page ${item.number}</h2><p>Mean RGB channel error: ${item.meanChannelError.toFixed(4)} / 255. Pixels with a channel difference above 32: ${(item.changedPixelFraction * 100).toFixed(4)}%.</p><div class="grid"><figure><figcaption>Paged HTML · Chromium</figcaption><a href="showcase-page-${item.number}/paged-first-page.png"><img alt="Showcase page ${item.number} rendered in Chromium" src="showcase-page-${item.number}/paged-first-page.png"></a></figure><figure><figcaption>PDF · PDF.js</figcaption><a href="showcase-page-${item.number}/pdf-first-page.png"><img alt="Showcase page ${item.number} rendered from PDF" src="showcase-page-${item.number}/pdf-first-page.png"></a></figure><figure><figcaption>Difference · red pixels</figcaption><a href="showcase-page-${item.number}/raster-difference.png"><img alt="Raster differences for showcase page ${item.number}" src="showcase-page-${item.number}/raster-difference.png"></a></figure></div></section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Earlyx · Browser verification</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#1d2d41;font:16px/1.6 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:36px 24px}h1{font-size:34px;letter-spacing:-1px}a{color:#175aca}section{margin:40px 0}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}figure{margin:0;background:white;border:1px solid #dce2ea;border-radius:9px;overflow:hidden}figcaption{padding:12px 16px;font-size:14px;font-weight:600;border-bottom:1px solid #dce2ea}img{display:block;width:100%;height:auto}li{padding:5px 0}.pass{color:#26754e}.screens{display:grid;grid-template-columns:2fr 1fr;gap:18px}.screens img{object-fit:contain;object-position:top}small{color:#617086}@media(max-width:800px){.grid,.screens{grid-template-columns:1fr}main{padding:24px 16px}}</style><main><a href="../index.html">← Stage reports</a><h1>Actual browser behavior. Actual rendered pages.</h1><p class="pass">${report.checks.length} checks passed in ${report.totalMs} ms · Chromium ${escape(report.browser)}.</p><ul>${report.checks.map(check => `<li><span class="pass">✓</span> ${escape(check.name)}</li>`).join('')}</ul><p><a href="report.json">Raw measurements</a> · <a href="download.pdf">Test PDF download</a> · <a href="download.web.html">Test web download</a></p>${pageViews}<section><h2>The live editor</h2><div class="screens"><figure><figcaption>Desktop</figcaption><a href="desktop-editor.png"><img alt="Desktop live editor screenshot" src="desktop-editor.png"></a></figure><figure><figcaption>Mobile</figcaption><a href="mobile-editor.png"><img alt="Mobile live editor screenshot" src="mobile-editor.png"></a></figure></div></section><p><small>Raster comparisons allow antialiasing differences and cover these fixtures. They do not establish identical pixels on every platform or accessibility conformance. Captured ${escape(new Date(report.capturedAt).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }))} KST.</small></p></main></html>`;
}

async function visualParity(page, result, directory, pageIndex = 0) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  // A page taller than its editor iframe cannot be captured by a locator
  // screenshot without clipping into the parent UI. Render the exact returned
  // HTML in a dedicated viewport large enough for the complete printed page.
  const viewer = await page.context().newPage();
  await viewer.setViewportSize({ width: 1100, height: 1600 });
  await viewer.setContent(result.html);
  await viewer.addStyleTag({ content: 'body{background:white}.pages{padding:0;gap:0;justify-content:start}.page{box-shadow:none}' });
  // Place the selected page at an integer viewport origin. Capturing a later
  // page at a fractional scroll offset otherwise creates a false one-pixel
  // translation in the raster comparison.
  await viewer.locator('.page').evaluateAll((pages, selected) => pages.forEach((element, index) => { element.style.display = index === selected ? 'block' : 'none'; }), pageIndex);
  const vector = viewer.locator('.page > svg').nth(pageIndex);
  const dimensions = await vector.boundingBox();
  if (!dimensions) throw new Error('Paged HTML SVG has no visible dimensions.');
  await vector.screenshot({ path: path.join(directory, 'paged-first-page.png') });
  const pdfResponse = await page.request.get(new URL(result.pdfUrl, page.url()).href);
  const task = getDocument({ data: new Uint8Array(await pdfResponse.body()), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const first = await pdf.getPage(pageIndex + 1);
    const original = first.getViewport({ scale: 1 });
    const viewport = first.getViewport({ scale: dimensions.width / original.width });
    const image = await loadImage(await readFile(path.join(directory, 'paged-first-page.png')));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    await first.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
    await writeFile(path.join(directory, 'pdf-first-page.png'), canvas.toBuffer('image/png'));
    const other = createCanvas(image.width, image.height);
    const otherContext = other.getContext('2d');
    otherContext.fillStyle = 'white'; otherContext.fillRect(0, 0, image.width, image.height);
    otherContext.drawImage(image, 0, 0);
    const actual = context.getImageData(0, 0, canvas.width, canvas.height);
    const expected = otherContext.getImageData(0, 0, canvas.width, canvas.height);
    const diff = context.createImageData(canvas.width, canvas.height);
    let absoluteError = 0, changed = 0;
    for (let offset = 0; offset < actual.data.length; offset += 4) {
      const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(actual.data[offset + channel] - expected.data[offset + channel])));
      absoluteError += [0, 1, 2].reduce((sum, channel) => sum + Math.abs(actual.data[offset + channel] - expected.data[offset + channel]), 0);
      if (delta > 32) changed++;
      diff.data[offset] = delta > 32 ? 220 : 255;
      diff.data[offset + 1] = delta > 32 ? 50 : 255;
      diff.data[offset + 2] = delta > 32 ? 65 : 255;
      diff.data[offset + 3] = 255;
    }
    const differenceCanvas = createCanvas(canvas.width, canvas.height);
    differenceCanvas.getContext('2d').putImageData(diff, 0, 0);
    await writeFile(path.join(directory, 'raster-difference.png'), differenceCanvas.toBuffer('image/png'));
    const meanChannelError = absoluteError / (canvas.width * canvas.height * 3);
    const changedPixelFraction = changed / (canvas.width * canvas.height);
    assert.ok(meanChannelError < 3, `mean raster channel error ${meanChannelError} exceeds 3/255`);
    assert.ok(changedPixelFraction < .02, `fraction of pixels differing by >32 levels is ${changedPixelFraction}, exceeds 2%`);
    return { width: canvas.width, height: canvas.height, meanChannelError, changedPixelFraction, thresholds: { maxMeanChannelError: 3, maxChangedPixelFraction: .02, changedPixelChannelDelta: 32 }, note: 'Measured fixture page; allows antialiasing differences. This is not a claim about every document.' };
  } finally { await task.destroy(); await viewer.close(); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
