## Changes should stay local when possible
@label("incremental")

An incremental compiler keeps useful work from the previous edit. Paragraphs with identical content and style can reuse their shaped text and line layout. Page assembly still runs far enough to account for content that moved.

An edit at the beginning of a document can change every following page. An honest benchmark separates that case from replacing one word near the end.

@table(caption: "What can be reused", id: "reuse")
| Input | Cached result |
| --- | --- |
| Font file and text run | Shaped glyphs |
| Paragraph and width | Broken lines |
| Unchanged page geometry | Browser page elements |
