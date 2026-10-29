@title "The document is the source"
@author "Earlyx Studio"
@description "A complete Earlyx example with math, references, tables, figures, reusable components, and includes."
@language "en"
@page(size: "a4", margin: 48)
@style(fontSize: 11, lineHeight: 1.45, color: "#263238", accent: "#b34f35")

@component note(title, body) {
### {{title}}
{{body}}
}

# The document is the source
@label("intro")

This is a small technical document written in **Earlyx**. Content stays readable, equations stay first-class, and one layout feeds both the paged web view and PDF.

@toc(title: "In this document")

## Structure before decoration

A heading is a heading. A table is a table. The compiler preserves those meanings while arranging content on the page. See @ref("outputs") for the output contracts and @ref("pipeline") for the compilation pipeline.

@use note(title: "A useful constraint", body: "Keep content separate from templates. Explicit dependencies make documents easier to reproduce and make cached results easier to trust.")

## Equations with context

For observations $x_1, x_2, \ldots, x_n$, the sample mean is:

$$
\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i
$$
@label("mean")

@ref("mean") can appear in a paragraph, a reference, or a caption. Mathematical notation remains attached to its document structure.[^notation]

$$
\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}
\begin{bmatrix} x \\ y \end{bmatrix}
= \begin{bmatrix} x + 2y \\ 3x + 4y \end{bmatrix}
$$

@table(caption: "Output contracts", id: "outputs")
| Output | Layout | Reading behavior |
| --- | --- | --- |
| PDF | Fixed pages | Print and offline exchange |
| Paged HTML | Shared page geometry | Browser preview and review |
| Responsive HTML | Reflowable | Narrow screens and web publication |

## From source to pages

@figure("assets/pipeline.svg", caption: "One semantic document branches into responsive HTML and a shared page layout.", alt: "Source feeds a semantic document. One branch creates responsive HTML; another creates positioned pages used by PDF and paged HTML.", id: "pipeline", width: 460)

Good typography requires more than a new syntax. Line breaking, fonts, mathematical spacing, and page layout all matter. @cite("knuth1984")

```js
const document = parse(source);
const pages = layout(document);
exportPdf(pages);
exportPagedHtml(pages);
```

@pagebreak()

@include("chapter.ex")

## Reproducible by design

- Font files and package versions are explicit inputs.
- Local dependencies are loaded from the project.
- Reusable components have scoped parameters.
- Incomplete syntax produces a source diagnostic.

A web page should remain useful when read with keyboard navigation, copied into another application, or explored with assistive technology. Appearance and semantics both need verification. @cite("w3c2023")

Read the [language guide](https://example.com/earlyx) or start from @ref("intro").

[^notation]: Earlyx uses familiar mathematical notation inside dollar delimiters; a TeX installation is not required.

@bibliography("references.json")
