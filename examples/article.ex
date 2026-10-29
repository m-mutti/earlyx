@title "Incremental documents, explained"
@author "Earlyx Research"
@description "A short technical article demonstrating semantic document structure."
@language "en"
@page(size: "a4", margin: 54)
@style(fontSize: 11, lineHeight: 1.45, color: "#263238", accent: "#b34f35")

# Incremental documents, explained
@label("introduction")

A document compiler does more than replace markup with styled text. It interprets structure, shapes glyphs, breaks lines, and determines which content belongs on each page.

The useful question is how much of that work must happen again when an author changes one sentence. The answer depends on the edit: replacing a word may affect one paragraph, while inserting a new section can shift many pages.

## A dependency-aware pipeline

We treat parsing, paragraph layout, and page assembly as separate stages. Unchanged inputs can reuse earlier results. This idea follows the long tradition of separating a document's content from its typesetting rules. @cite("knuth1984")

$$
T_{edit} = T_{parse} + T_{changed\ blocks} + T_{pagination}
$$
@label("cost")

@ref("cost") describes work rather than a universal speed guarantee. A reference to the final page count can require another layout pass.[^global]

## What to measure

1. Initial compilation with a cold process.
2. Repeated compilation with font and layout caches available.
3. Typical text edits near the beginning, middle, and end.
4. Document-wide changes such as font size or margins.

@table(caption: "Performance scenarios", id: "scenarios")
| Scenario | Expected work |
| --- | --- |
| Local word replacement | Reuse unchanged paragraphs |
| New paragraph | Reflow the affected pages |
| Font change | Shape and lay out the document again |

@ref("scenarios") keeps benchmark results attached to the editing scenario that produced them. Timings should report the hardware, document size, and whether caches were warm.

## Rendering contracts

Paged HTML uses the compiler's page geometry, allowing it to match the PDF's line breaks and page breaks. Responsive HTML preserves the meaning and design while allowing text to fit the reader's screen.

The two views are useful for different reading situations. Export should make that choice explicit and retain headings, references, links, and alternative text.

[^global]: Contents pages, footnotes, and page-number references can introduce dependencies beyond the edited paragraph.

@bibliography("references.json")
