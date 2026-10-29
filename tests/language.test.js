import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseArguments, parseInline } from '../src/language.js';

test('parses metadata, settings, heading, and source offsets including CRLF', () => {
  const source = '@title "A document"\r\n@page(size: "letter", margin: 54)\r\n@style(fontSize: 12, color: "#102030")\r\n# Introduction\r\n\r\nTwo lines\r\nform one paragraph.';
  const document = parse(source, { filename: 'paper.ex' });
  assert.deepEqual(document.diagnostics, []);
  assert.equal(document.metadata.title, 'A document');
  assert.equal(document.page.size, 'letter');
  assert.equal(document.style.fontSize, 12);
  assert.equal(document.blocks[0].type, 'heading');
  assert.equal(document.blocks[0].source.line, 4);
  assert.equal(source.slice(document.blocks[0].source.start, document.blocks[0].source.end), '# Introduction');
  assert.equal(document.blocks[1].text, 'Two lines form one paragraph.');
});

test('inline syntax retains nested semantics, escapes, links, math, references, and footnotes', () => {
  const nodes = parseInline('**strong _nested_** `code` $x^2$ [web](https://example.com) @ref("intro") @cite("knuth") [^note] \\*plain\\*');
  assert.equal(nodes[0].type, 'strong');
  assert.equal(nodes[0].children[1].type, 'emphasis');
  assert.equal(nodes.find(node => node.type === 'math').text, 'x^2');
  assert.equal(nodes.find(node => node.type === 'link').target, 'https://example.com');
  assert.equal(nodes.find(node => node.type === 'ref').target, 'intro');
  assert.equal(nodes.find(node => node.type === 'cite').key, 'knuth');
  assert.equal(nodes.find(node => node.type === 'footnote').key, 'note');
  assert.equal(nodes.at(-1).text, ' *plain*');
  assert.equal(parseInline('a_variable_name')[0].text, 'a_variable_name');
  assert.equal(parseInline('[unsafe](javascript:alert)')[0].type, 'text');
});

test('directive parser accepts strings and arrays but cannot execute JavaScript', () => {
  assert.deepEqual(parseArguments('"a,b", text: "a:b", count: 1.5, values: [true, "x"]'), {
    positional: ['a,b'], named: { text: 'a:b', count: 1.5, values: [true, 'x'] },
  });
  assert.throws(() => parseArguments('process.exit()'), /Expected quoted/);
  assert.throws(() => parseArguments('text: "missing'), /Close the quoted/);
  assert.throws(() => parseArguments('count: 1, count: 2'), /repeated/);
  assert.throws(() => parseArguments('1e999'), /finite/);
  const invalid = parse('@style(fontSize: process.exit())\n# Still parsed');
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(invalid.blocks[0].text, 'Still parsed');
});

test('content identities survive unrelated insertions, including list item source changes', () => {
  const before = parse('# Heading\n\n- First\n- Second\n\nA paragraph.');
  const after = parse('New introduction.\n\n# Heading\n\n- First\n- Second\n\nA paragraph.');
  assert.deepEqual(before.blocks.map(block => block.id), after.blocks.slice(1).map(block => block.id));
  assert.notEqual(before.blocks[1].source.line, after.blocks[2].source.line);
});

test('tables, figures, labels, file dependencies, and explicit page breaks', () => {
  const doc = parse('# Introduction\n@label("intro")\n\n@table(caption: "Results", id: "results")\n| Method | Time |\n| --- | --- |\n| Cold | 10 ms |\n| Warm | 1 ms |\n\n@figure("assets/graph.svg", caption: "A graph", alt: "Two connected boxes", id: "graph")\n@include("chapter.ex")\n@bibliography("references.json")\n@pagebreak()');
  assert.deepEqual(doc.diagnostics, []);
  assert.equal(doc.blocks[0].label, 'intro');
  assert.deepEqual(doc.blocks[1].headers, ['Method', 'Time']);
  assert.deepEqual(doc.blocks[1].rows, [['Cold', '10 ms'], ['Warm', '1 ms']]);
  assert.equal(doc.blocks[1].label, 'results');
  assert.equal(doc.blocks[2].alt, 'Two connected boxes');
  assert.equal(doc.blocks.at(-1).type, 'pagebreak');
  assert.deepEqual(doc.dependencies.map(dependency => dependency.kind), ['figure', 'include', 'bibliography']);
  assert.equal(parse('@include("https://example.com/a.ex")').diagnostics[0].severity, 'error');
});

test('component parameters are scoped, expanded as content, and mapped to their call site', () => {
  const doc = parse('@component note(title, body) {\n## {{title}}\n{{body}}\n}\n@use note(title: "First", body: "One")\n@use note("Second", "Two")');
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.blocks.map(block => block.text), ['First', 'One', 'Second', 'Two']);
  assert.equal(doc.blocks[0].source.line, 5);
  assert.equal(doc.blocks[0].expansion.definition.line, 1);
  const recursive = parse('@component recurse() {\n@use recurse()\n}\n@use recurse()');
  assert.equal(recursive.diagnostics[0].code, 'component-recursion');
  assert.equal(recursive.blocks.length, 0);
  assert.match(parse('@component note(title) {\n{{title}}\n}\n@use note()').diagnostics[0].message, /Supply/);
});

test('incomplete documents return diagnostics and preserve useful blocks', () => {
  const code = parse('# Before\n\n```js\nconst value = 1;');
  assert.equal(code.blocks.length, 2);
  assert.equal(code.blocks[1].text, 'const value = 1;');
  assert.equal(code.diagnostics[0].code, 'unclosed-code');
  const math = parse('$$\\frac{1}{2}');
  assert.equal(math.blocks[0].type, 'math');
  assert.equal(math.diagnostics[0].code, 'unclosed-math');
  const directive = parse('@page(size: "a4"\n\n# After');
  assert.equal(directive.blocks[0].text, 'After');
  assert.match(directive.diagnostics[0].message, /Close/);
});

test('duplicate labels and footnotes produce actionable diagnostics', () => {
  const doc = parse('# One\n@label("same")\n# Two\n@label("same")\n\n[^note]: First\n[^note]: Second');
  assert.ok(doc.diagnostics.some(diagnostic => diagnostic.message.includes('Label same')));
  assert.ok(doc.diagnostics.some(diagnostic => diagnostic.code === 'duplicate-footnote'));
  assert.equal(doc.footnotes.note.text, 'Second');
  assert.equal(Object.getPrototypeOf(parse('[^__proto__]: Safe text').footnotes), null);
});

test('invalid settings and inconsistent table rows fail locally', () => {
  const doc = parse('@style(fontSize: -1)\n@style(color: "red")\n@page(size: "unknown")\n@table()\n| A | B |\n| --- | --- |\n| Missing second column |\n\nStill usable.');
  assert.equal(doc.diagnostics.length, 4);
  assert.equal(doc.blocks.at(-1).text, 'Still usable.');
  assert.equal(doc.style.fontSize, 11);
});

test('large malformed input is bounded without evaluating source', () => {
  const document = parse('x'.repeat(2_000_001));
  assert.equal(document.blocks.length, 0);
  assert.equal(document.diagnostics[0].code, 'source-size');
  const repeated = '@component repeated(body) {\n{{body}}\n}\n' + '@use repeated("A short paragraph.")\n'.repeat(140);
  assert.ok(parse(repeated).diagnostics.some(diagnostic => diagnostic.code === 'component-budget'));
  const amplified = '@component amplify(body) {\n' + '{{body}} '.repeat(100) + '\n}\n@use amplify("' + 'x'.repeat(25_000) + '")';
  assert.ok(parse(amplified).diagnostics.some(diagnostic => /size limit/.test(diagnostic.message)));
});
