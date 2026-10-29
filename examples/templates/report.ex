@title "A reusable report template"
@author "Your team"
@language "en"
@page(size: "letter", margin: 54)
@style(font: "sans", fontSize: 11, lineHeight: 1.45, color: "#263238", accent: "#b34f35")

@component summary(title, body) {
## {{title}}
{{body}}
}

@use summary(title: "Executive summary", body: "This wrapper owns the document title, author, page settings, typography, and reusable components. Included files contain the report's content.")

@include("../chapter.ex")
