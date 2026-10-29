# Verification and stage reports

Run `npm run stages -- --stage 1` after the rendering prototype, then repeat with stage numbers 2 through 5 as their capabilities become available. `npm run stages -- --all` captures the current compiler against every stage fixture. Captures are real measurements, not reconstructed historical results.

Each run creates a timestamped directory under `artifacts/stage-N/`, containing source, paged HTML, responsive HTML, PDF, shared-layout JSON, independently extracted PDF text, raw timing samples, and an HTML report showing all views. Earlier captures remain intact. `artifacts/index.html` links the latest successful capture for each stage. Source archives include dependencies with a SHA-256 manifest; cold CLI compilation runs against the isolated snapshot.

Timing categories have different scopes:

- **First full export:** compiler wall time after module import, including PDF and both HTML outputs.
- **Warm edit:** a reused compiler, with `pdf:false`. Every sample modifies source; repeated identical-source calls are not presented as edit latency. p50 and p95 use nearest-rank percentiles.
- **Cold CLI:** elapsed time for a separate Node process to compile source and write all exports. Startup, module loading, font loading, and output I/O are included.
- **Twenty-page benchmark:** twenty explicit pages, an edit near the beginning, and the complete preview compilation path. A fresh compiler must produce identical positioned pages to the reused compiler's final result.

Independent PDF inspection uses PDF.js to decode the output, verifies page counts and page dimensions against shared layout, records decoded text, and measures origins of text runs that PDF.js preserves intact. These checks do not prove pixel equivalence or accessibility conformance. The report retains all origin deltas so discrepancies are visible.

`npm test` runs parser and integration checks. `npm run test:browser` runs actual editor interactions with Playwright and captures desktop/mobile screenshots under `artifacts/browser/`. The browser report at `artifacts/browser/index.html` shows independent PDF.js and Chromium raster renderings for all showcase pages, including equations, figures, tables, and notes. The thresholds permit mean RGB channel error below 3/255 and fewer than 2% of pixels with any channel difference above 32/255. Raw values and difference images are retained. Browser installation can be isolated with `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/earlyx-browsers npx playwright install chromium`.

Stage 5 is an acceptance capture, not only another sample document. It reruns the complete Node test suite and the browser suite, saves their raw evidence, reads the distribution build report, and verifies the SHA-256 digest of each distributable archive. Run `npm run build` before capturing stage 5. Local socket/browser tests may require permission to run outside a network-restricted execution sandbox. Freeze production changes before the final build and stage 5 capture; rebuilding archives afterward changes the digests recorded by the report.

The stress checks include one hundred explicit pages, repeated table headers across long tables, body/footnote separation, fresh-versus-cached layout equivalence, global style invalidation, dependency freshness, recoverable diagnostics, and independent PDF link destinations. Browser structure checks verify unique ids, resolving internal links, MathML presence, table header scope, mobile publication width, and selection text that retains spaces. Worker tests observe an actual started job before requesting cancellation and verify that the worker remains usable afterward.

The preview's glyph paths and PDF's embedded text are rendered differently at the rasterization boundary. Matching source geometry is the intended invariant; antialiasing differences across PDF viewers, browsers, zoom levels, and displays are expected. Responsive HTML is permitted to reflow.

Automated checks are evidence for the fixtures and interactions they cover. They do not establish complete Unicode coverage, PDF/UA conformance, correct reading order for arbitrary documents, lossless LaTeX imports, or publication compliance with every journal.
