# macOS and Linux reproducibility

Run `node scripts/reproducibility.js` from the source checkout after the final `npm run build`. The check requires a native macOS host, Docker, and a previously pulled official `node:24-alpine` image. It uses Docker's `--pull never` option, so the measurement does not download software. Set `EARLYX_LINUX_IMAGE` to an already present Node image tag or digest to reproduce a specific environment.

The script rejects a distribution whose source manifest differs from the current source files. It then uses the same `dist/earlyx-node` dependency-bundled CLI on both operating systems, without installing dependencies or consulting a project `node_modules` directory. The host supplies Node.js; Linux gets Node.js from the container image. The host runtime version, Linux runtime version, ICU and zlib versions, Docker version, image identifier and repository digest are recorded.

Linux runs with networking disabled, a read-only root filesystem, a read-only compiler bundle, dropped capabilities and a writable temporary project volume. The project contains copies of the bundled examples and output directories. Host compilation uses an isolated project and empty Node package search overrides; deliberately invalid proxy addresses discourage accidental network use, but this does not constitute an operating-system network sandbox on the host.

## Fixtures and comparisons

Five fixtures are compiled independently in fresh CLI processes on each platform: `minimal.ex`, `article.ex`, `showcase.ex`, `multilingual.ex`, and a generated document with exactly 20 pages. The showcase includes imported source, a bibliography and SVG assets. The generated fixture is saved with the results so its exact input can be reviewed.

Every page and positioned item in the emitted layout JSON is compared recursively. Only absolute `source.file` filenames are normalized to `PROJECT/relative/path`, since the isolated project has a different absolute location in each environment. Numeric fields use an absolute tolerance of one millionth of a point (`1e-6`). Strings, array order, object fields, page counts, text content, glyph information, SVG content and other values must match. The report records the number of numeric fields checked, maximum numeric difference and up to 25 detailed mismatch locations; it also records the total mismatch count.

The two HTML outputs are compared by SHA-256 after the same project-root filename normalization. The PDF files are hashed without modification. Byte-identical PDFs are reported separately from geometry agreement: different compression implementations or metadata could change a byte hash without changing document layout. A byte mismatch is therefore visible in the report even when layout and HTML checks pass. The command exits with a failure if either layout or normalized HTML differs.

Outputs are preserved at `artifacts/reproducibility/host/` and `artifacts/reproducibility/linux/`, including PDF, paged HTML, responsive HTML, layout JSON and timing JSON. `artifacts/reproducibility/index.html` links to both environments' outputs; `report.json` records the full evidence, source manifest, complete bundle inventory, runtime versions, image digest and recipe hashes.

## Timing scope and limits

The table shows compiler-reported engine time, including parsing, layout and HTML/PDF generation. Native process wall time includes Node startup and output writes. Linux wall time additionally includes container startup and shared-volume overhead. These wall times are recorded separately and should not be treated as a direct compiler speed comparison.

This is an actual execution check for these fixtures on these two environments. It does not establish Windows support, every CPU architecture, every writing system, arbitrary document correctness, PDF accessibility conformance or pixel identity between viewers. The multilingual fixture remains a smoke sample; any compiler warnings are retained in the output timing files and report. HTML reflow remains distinct from the shared paged layout.
