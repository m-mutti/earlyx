# Earlyx

**A modern alternative to LaTeX, built for realtime document rendering and publishing to PDF and the web from one source.**

Earlyx is a document language, compiler, and local writing environment for technical articles and reports. Write readable `.ex` files with equations, tables, figures, citations, and reusable components. See the result while you type, then export a PDF, a paged HTML document, or a responsive web page.

Version **0.1.0** is a working early release with an explicitly supported feature set. It has its own document syntax and uses familiar TeX-style mathematical notation; it does not require a TeX installation.

## Why Earlyx?

Earlyx addresses common sources of friction in LaTeX workflows:

| Need | Earlyx approach |
| --- | --- |
| A preview that keeps up with editing | Cache unchanged paragraph layouts and shaped text, compile in a persistent worker, and cancel obsolete work. Generate PDFs on demand so serialization stays off the typing path. |
| Publish to both print and web | Export PDF, paged HTML, and responsive HTML from one semantic document model. |
| Consistent preview and export | Use the same font files, positioned text, equation graphics, line breaks, and page breaks for PDF and paged HTML. |
| Readable source and useful errors | Use straightforward markup and declarative directives, with diagnostics that point back to the source. |
| Simpler setup and reproducible builds | Run locally with Node.js or build an offline distribution containing the compiler, dependencies, fonts, and an optional runtime. |
| Reuse without arbitrary document code | Define scoped components and wrapper templates, and track local includes, figures, and bibliography files explicitly. |

The goal is a fast, predictable writing workflow. A new syntax alone does not make typesetting faster, and Earlyx does not claim to outperform every existing compiler.

## Quick start

With **Node.js 22 or newer**:

```sh
git clone https://github.com/m-mutti/earlyx.git
cd earlyx
npm ci
npm start
```

Open **http://127.0.0.1:4317**. Choose an example, edit its source, and switch between **Paged**, **Web**, and **PDF**. The editor displays measured compile times, supports downloads, and lets you click preview text to find its source.

Compilation runs locally. A hosted service, TeX installation, and browser automation are not required to compile documents.

## Write a document

```text
@title "A document starts with an idea"
@author "Your name"
@page(size: "a4", margin: 48)
@style(font: "serif", fontSize: 11, lineHeight: 1.45)

# Introduction
@label("intro")

Write **clear content** with an inline equation: $E = mc^2$.

## A small result

$$
\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i
$$

- Keep the source readable.
- Preview while you write.
- Publish the same content in multiple formats.

See @ref("intro").
```

Read the [language guide](docs/language.md), explore the [complete showcase](examples/showcase.ex), or start from the [reusable report template](examples/templates/report.ex).

## Compile and watch

```sh
node bin/earlyx.js compile examples/showcase.ex --out artifacts/showcase
node bin/earlyx.js watch examples/showcase.ex --out artifacts/showcase
```

Each build writes:

| File | Contents |
| --- | --- |
| `showcase.pdf` | A paginated PDF with embedded, selectable text |
| `showcase.html` | A fixed-page HTML view using the shared layout |
| `showcase.web.html` | Responsive HTML with semantic document structure |
| `showcase.layout.json` | Positioned pages and their contents |
| `showcase.timings.json` | Compilation timings and diagnostics |

Watch mode rebuilds when the source, included documents, figures, or bibliography changes. Invalid source still produces inspectable output where possible; the compile command exits unsuccessfully when errors remain. Use `--root` to set the project directory when compiling another project.

## What “the same in HTML and PDF” means

**Paged HTML and PDF share layout decisions.** The browser draws glyph outlines from the bundled fonts; the PDF embeds text from those same fonts. Equations and normalized SVG figures use shared vector graphics. Line breaks, page breaks, and positions come from one layout engine. Rasterization can still produce small pixel differences between browsers, PDF viewers, zoom levels, and displays.

**Responsive HTML adapts to the reader's screen.** It preserves content and document structure while allowing wrapping to change. It includes headings, lists, links, tables, references, notes, figure descriptions, and MathML. A mobile web page cannot both reflow naturally and retain a printed page's exact line breaks.

Paged HTML also includes a text selection layer and a semantic reading view. PDF contains a structure tree and equation descriptions. These features are a foundation for accessibility; they are not a claim of PDF/UA or WCAG conformance.

## Supported in v0.1

- Headings, paragraphs, emphasis, links, inline code, fenced code, and nested lists.
- Inline and display mathematics through a bounded TeX-style syntax, rendered with MathJax.
- Tables with repeated headers and splitting of tall rows across pages.
- Anchored, static SVG figures with captions and alternative text.
- Structural references, numeric citations, local JSON bibliographies, page footnotes, and contents lists.
- Scoped components, included files, and wrapper templates separating page settings from body content.
- A4, A5, Letter, and custom page sizes; bundled serif, sans-serif, and monospace fonts; colors and alignment.
- Live previews, source navigation, dependency tracking, cancellation, and stale-response protection.

Document source does not execute JavaScript or shell commands. File dependencies must remain inside the declared project root, including after resolving symbolic links. Compilation does not fetch remote document dependencies.

## Performance and verification

The recorded 20-page benchmark on an **Apple M4, macOS ARM64, Node.js 24.22.1** measured:

| Warm preview edit | Time |
| --- | ---: |
| Median | 22.5 ms |
| p95 | 29.52 ms |

Each sample edits source near the beginning of the document and reuses the compiler. These are engine timings for preview generation, excluding PDF serialization, process startup, worker queueing, and the editor debounce. Cached output was checked against a fresh compilation. Results describe the measured fixtures and machine, not guaranteed latency for arbitrary documents.

The recorded acceptance run passed **49 automated tests and 16 Chromium browser checks**. Checks cover editing and downloads, cancellation, error recovery, source navigation, mobile rendering, internal links, MathML, text selection, 100-page documents, table pagination, footnote spacing, and PDF/HTML raster comparisons across every showcase page.

Five fixtures compiled with the same bundled compiler on **macOS ARM64 and Linux ARM64** produced matching layouts and byte-identical PDFs. Both HTML outputs matched after normalizing project-root filenames. This does not establish support for every platform or writing system.

An informational baseline against **Typst 0.15.1** is reproducible with `scripts/compare.js`. Typst was faster at cold PDF generation in that run. The invocations perform different work: Earlyx writes PDF, both HTML formats, layout JSON, and timings; Typst writes PDF only. The baseline is not a matched-output speed ranking.

Run the checks and regenerate evidence:

```sh
npm test
npx playwright install chromium
npm run test:browser
node scripts/stages.js --stage 1
# Repeat with --stage 2, 3, and 4 as needed.
npm run build
node scripts/stages.js --stage 5
```

Generated timing reports, source snapshots, PDF/HTML views, and browser screenshots live under `artifacts/`, which is excluded from Git. With the local editor running, open `/artifacts/index.html` for the stage dashboard. Stage 5 verifies the tests, browser checks, current build source fingerprint, and distribution checksums. See [verification details](docs/verification.md) and the separate [macOS/Linux reproducibility procedure](docs/reproducibility.md).

## Offline distributions

`npm run build` creates bundled archives under `dist/`: a portable distribution requiring Node.js, a local npm-installable package, and a self-contained archive with the build machine's Node runtime. The recorded runtime build targets macOS ARM64. Building the archives also checks isolated CLI compilation, worker previews, and lazy PDF export without `node_modules`.

The compiler uses PDFKit, fontkit, MathJax, SVG-to-PDFKit, and an XML parser. Dependencies and fonts are bundled for distribution rather than reimplemented or omitted. See [distribution instructions](docs/distribution.md) for installation, checksums, licenses, and platform limits.

## Current limits

- General `.tex` import, LaTeX packages, and arbitrary LaTeX macros are not supported.
- Full bidirectional paragraph ordering, automatic hyphenation, and advanced paragraph optimization remain further work. Arabic word shaping is supported; multilingual fixtures are smoke tests, not complete Unicode coverage.
- Figures are anchored where written. Floating figures, multicolumn layouts, and merged table cells are not implemented. Footnotes exceeding page capacity produce a source error.
- SVG figures use a static, self-contained subset. Complex text spans must be converted to paths, and label fonts normalize to bundled fonts.
- Bibliographies use basic numeric formatting rather than a complete CSL style engine. Contents lists do not include page numbers.
- Detailed accessibility assessment, full PDF table/list tagging, a font/package registry, and additional platform verification remain future work.

## License

Earlyx source is [MIT licensed](LICENSE). Bundled fonts and third-party dependencies retain their own licenses; font notices are included in [assets/fonts](assets/fonts), and distribution builds collect dependency notices.
