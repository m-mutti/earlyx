# Running and distributing Earlyx

The source project requires Node.js 22 or newer and `npm ci`. Builds use the committed package lock and produce bundled distributions that need no dependency installation at runtime. The compiler and web editor run locally; compilation does not need a TeX installation or a cloud service.

## Self-contained archive

Run `npm run build` from the source checkout. The build creates:

- `dist/earlyx-0.1.0-darwin-arm64.tar.gz`: a self-contained archive when built on the verified macOS Apple Silicon machine. It includes the Node.js runtime, compiler, fonts, web editor, examples, documentation, and third-party notices.
- `dist/earlyx-0.1.0-node.tar.gz`: a smaller bundled distribution requiring an existing Node.js 22+ runtime.
- `dist/earlyx-0.1.0.tgz`: a local npm-installable package of the bundled compiler.
- `dist/SHA256SUMS` and `dist/build-report.json`: checksums, artifact sizes, and measured smoke-test results.

The runtime archive filename changes with the version, operating system, and CPU architecture of the build machine. The runtime is platform-specific; this release does not establish support for Linux, Windows, or Intel macOS. A matching build and equivalent verification are required for those platforms. The executable may depend on ordinary system libraries supplied by its operating system.

Extract the self-contained archive and run from its directory:

```sh
tar -xzf earlyx-0.1.0-darwin-arm64.tar.gz
cd earlyx-runtime
./earlyx serve
```

Open the localhost address printed by the command. To compile the included showcase:

```sh
./earlyx compile examples/showcase.ex
```

The compiler writes paged HTML, responsive HTML, PDF, shared layout JSON, and timing JSON under `artifacts/showcase/`. To compile a file in another project:

```sh
/path/to/earlyx-runtime/earlyx compile paper.ex --root /path/to/project --out output
```

Includes, bibliography files, and figure files must remain inside that project root. Files are re-read on each build. `watch` monitors the source and its dependencies, including missing project-local dependencies so creation or restoration can trigger another build.

The smaller Node-required archive runs with `node bin/earlyx.js serve`. Its bundled dependencies and fonts are included, so `npm install` is unnecessary. The npm archive can also be installed from a local path using `npm install -g /path/to/earlyx-0.1.0.tgz` on a machine with Node/npm installed.

## What the build verifies

The build copies each distribution into an isolated temporary directory with no `node_modules`. It runs help, version, and the full showcase compilation, checks every expected output, checks the PDF header, and rejects compilation diagnostics with error severity. It also starts the packaged local editor, compiles through its worker API, and downloads a lazily generated PDF. For the runtime distribution these checks invoke the included `earlyx` launcher, which runs the copied Node executable. The smoke environment clears `NODE_PATH` and `NODE_OPTIONS`, restricts executable search paths, and points proxy settings at a closed local port. Compilation requires no network calls; this environment is an offline smoke check rather than an operating-system network sandbox.

`BUILD.json` records the exact bundled dependency versions, source lockfile hash, JavaScript bundle hash, and runtime hash. Licenses are copied from included packages and the Node runtime; the font licenses remain with their font files. The original Earlyx code is MIT-licensed. The distribution does not claim to be a single native machine-code executable: it is one downloadable archive with a launcher, bundled JavaScript, runtime, fonts, and static assets.

Available per-stage HTML/PDF reports are included when they exist at build time. Re-run the stage captures before building to package updated evidence. Timings vary with machine load, hardware, input, and cache state. Automated PDF structure checks and browser screenshots do not establish complete PDF/UA or WCAG conformance; consult the reliability notes for remaining typography and accessibility limits.
