# The Earlyx language

Earlyx is a declarative document language. Its source describes document structure, mathematics, and local file dependencies. The compiler turns the same semantic document into a paged web view, PDF, and responsive HTML. It does not execute JavaScript, launch commands, or download dependencies while compiling a document.

## Start with text

```earlyx
@title "An example"
@author "Ada Author"
@language "en"
@page(size: "a4", margin: 54)
@style(font: "serif", fontSize: 11, lineHeight: 1.45, color: "#263238")

# Introduction

Paragraphs can span source lines. A blank line starts a new paragraph.
Use **strong text**, *emphasis*, `inline code`, or [a link](https://example.com).

- One item
- Another item

1. An ordered item
2. The next item
```

Headings use one through six `#` characters. Lists may use `-`, `+`, `*`, or numbered markers. Two spaces indent a list item by one level. Lists have one-line items in this version; use separate paragraphs for longer explanations. Lines beginning with `//` are comments. Escape literal markup with a backslash, for example `\*literal asterisks\*`.

Settings apply to the whole main document. Page sizes are `"a4"`, `"a5"`, and `"letter"`; explicit `width` and `height` override the named size. Dimensions and margins are in points (72 points = one inch). Fonts are the bundled aliases `"serif"` (Source Serif), `"sans"` (Source Sans), and `"mono"` (Source Code). The compiler constrains extreme dimensions and margins to keep pages usable. Colors use six-digit hex notation. Supported style keys are `font`, `fontSize`, `lineHeight`, `color`, `accent`, and `align`. Alignment values are `left`, `center`, `right`, and `justify`. The accent color is used for links and references. Responsive HTML embeds the bundled font files needed by the laid-out content for offline reading.

## Mathematics and code

Inline mathematics uses dollar delimiters: `$A = \pi r^2$`. Display mathematics uses a line beginning with `$$`, a mathematical expression, and a closing `$$`:

```earlyx
$$
\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i
$$
@label("mean")

See @ref("mean") for the sample mean.
```

The math renderer supports familiar TeX-style mathematical notation without requiring a TeX installation. That notation does not enable LaTeX packages or arbitrary document macros. Both `$$x^2$$` and multiline equations are accepted. Code blocks use triple backticks, optionally followed by a language name; code is preserved as content and is never executed.

## Tables, figures, and labels

```earlyx
@table(caption: "Measured scenarios", id: "results")
| Scenario | Result |
| --- | --- |
| Cold process | Measure separately |
| Warm edit | Reuse cached work |

@figure("assets/pipeline.svg", caption: "Compilation pipeline", alt: "Source branches into web and paged output", id: "pipeline", width: 460)

See @ref("results") and @ref("pipeline").
```

Table rows must have equal numbers of cells. A pipe table also works without an `@table` directive. A `\|` inside a table cell represents a literal pipe. Figures currently accept static, self-contained SVG files. SVG scripts, external resources, event handlers, animation, and embedded HTML are rejected. A figure's optional width is measured in points and preserves its aspect ratio. Give each figure useful alternative text.

`@label("name")` labels the immediately preceding block. Figure and table `id` arguments provide a shorter equivalent. Labels are unique across the assembled document and use letters, numbers, underscores, dots, and hyphens. `@ref("name")` resolves to a numbered structural reference. `@toc(title: "Contents")` inserts a document outline. `@pagebreak()` begins a new page; it is useful for controlled benchmark fixtures as well as publication layout.

## Citations and footnotes

```earlyx
The typography follows earlier work. @cite("knuth1984")

An edit may have nonlocal effects.[^pagination]

[^pagination]: Adding a line can shift the following pages.

@bibliography("references.json")
```

Bibliographies are local JSON files containing keyed entries:

```json
{
  "knuth1984": {
    "author": "Donald E. Knuth",
    "title": "The TeXbook",
    "year": 1984,
    "publisher": "Addison-Wesley"
  }
}
```

The compiler also accepts an array of entries with `id` fields and normalizes common CSL-style author and issued-year fields. This first version uses a simple numbered bibliography, not a complete citation-style engine. Footnote definitions are single-line source definitions; markers may occur in regular inline content.

## Reusable components and included files

```earlyx
@component note(title, body) {
### {{title}}
{{body}}
}

@use note(title: "A useful constraint", body: "Keep dependencies explicit.")
@use note("Another note", "Positional arguments also work.")

@include("chapter.ex")
```

Components are block templates with scoped, required parameters. Define a component before using it. `{{parameter}}` interpolates a supplied value into its body; it does not evaluate an expression. Arguments may contain strings, finite numbers, booleans, null, and arrays. Recursive component expansion is rejected, and nested expansion is bounded. Components are intended to produce content blocks; main-document metadata and settings belong outside component definitions.

Includes are resolved relative to the file containing the directive. Included files contribute content, footnotes, and dependencies; the main document controls metadata, styles, and page settings. Component definitions are file-scoped, and components defined by the parent document are available to included files. Includes are bounded to sixteen levels, cycles are diagnosed, and local files are re-read on each compile so changes do not leave stale cached content. Dependencies must remain inside the chosen project root, including after resolving symbolic links. Missing files produce source-located diagnostics while other content continues compiling.

`examples/templates/report.ex` is a complete wrapper template. It defines the report's page settings, sans-serif typography, accent color, and a reusable summary component, then includes `examples/chapter.ex` as content. Copy the wrapper and change its metadata or include path to create another report without mixing layout rules into the body text. `examples/article.ex` and `examples/showcase.ex` are additional starter documents.

## Parser and compiler API

`parse(source, { filename })` returns `metadata`, `page`, `style`, `blocks`, `diagnostics`, `dependencies`, `components`, and `footnotes`. Each block has a content-derived identity and a source location containing `file`, one-based `line` and `column`, and zero-based `start` and `end` UTF-16 offsets. Unrelated text insertions preserve identities for unchanged blocks. Repeated identical blocks receive occurrence suffixes. Component-generated blocks point to their call site and retain expansion metadata identifying the definition.

`parseInline(text)` returns semantic inline nodes. `parseArguments(text)` safely parses directive values without evaluating source. Parsing performs no I/O. The compiler owns project-safe file loading, dependency hashing, reference resolution, layout, and export. It bounds source sizes and expansion; unfinished code or math blocks remain available for preview with diagnostics.

The language parser recognizes structure independently of renderer support. The reliability report and generated examples are the authority for which rendering behaviors have been verified in a given release. Plain markup, templates, tables, and equations are the initial target; arbitrary LaTeX package compatibility is not provided.
