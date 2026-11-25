import * as assert from "node:assert/strict";
import { test } from "node:test";

import { anchorMentions } from "./yamlAnchors";

/**
 * Each mention as a person reads it: the line it is on, what is written, and
 * the line of the anchor it is.
 */
function read(text: string): string[] {
  const line = (offset: number) => text.slice(0, offset).split("\n").length;
  return anchorMentions(text).map((one) =>
    `${line(one.start)}: ${text.slice(one.start, one.end)} -> ${line(one.anchor)}`
  );
}

// Go to Definition lands on the anchor YAML itself would resolve, so a name
// anchored a second time takes the aliases below it and leaves the first its
// own. By name alone both anchors would claim both aliases.
test("an alias is the anchor of its name written last above it", () => {
  const text = "a: &x 1\nb: *x\nc: &x 2\nd: *x\n";
  assert.deepEqual(read(text), ["1: &x -> 1", "2: *x -> 1", "3: &x -> 3", "4: *x -> 3"]);
});

// A multi-document file repeats its names -- every manifest has a `&defaults`
// -- and an anchor does not outlive its document. The aliases on lines 4 and 8
// have none above them in theirs: nowhere to go, nothing to count towards.
test("a new document starts over", () => {
  const text = [
    "defaults: &defaults {retries: 3}",
    "web: *defaults",
    "---",
    "api: *defaults",
    "defaults: &defaults {retries: 5}",
    "job: *defaults",
    "...",
    "late: *defaults",
    "",
  ].join("\n");
  assert.deepEqual(read(text), [
    "1: &defaults -> 1",
    "2: *defaults -> 1",
    "5: &defaults -> 5",
    "6: *defaults -> 5",
  ]);
});

// A workflow's `run: |` is shell, where `*` and `&` are everywhere, and it is
// the file anchors are most likely to share with one. Only line 10 is an alias.
test("an asterisk or ampersand inside a scalar or a comment is text", () => {
  const text = [
    "env: &env {CI: \"1\"}",
    "steps:",
    "  - run: |",
    "      *env",
    "      make build && make test &env",
    "      ls *.log",
    "  - note: \"*env and &env\"",
    "  - also: '*env'",
    "  - plain: text *env &env   # *env",
    "  - env: *env",
    "",
  ].join("\n");
  assert.deepEqual(read(text), ["1: &env -> 1", "10: *env -> 1"]);
});

// Why this is not the daemon's parser: each of lines 2, 5 and 7 costs that one
// the whole file. A Helm template never parses, and `*` alone is what the file
// looks like one keystroke into typing an alias -- the moment the answers are
// being looked at.
test("a file that does not parse still answers", () => {
  const text = [
    "base: &base {a: 1}",
    "{{- if .Values.on }}",
    "one: *base",
    "{{- end }}",
    "list: [a, b",
    "two: *base",
    "three: *",
    "",
  ].join("\n");
  assert.deepEqual(read(text), ["1: &base -> 1", "3: *base -> 1", "6: *base -> 1"]);
});

test("names end where YAML ends them, in a flow collection and after a tag", () => {
  const text = [
    "a: &a {x: 1}",
    "b: !!map &b-2 {y: 2}",
    "c:",
    "  <<: [*a, *b-2]",
    "d: [&p 80, *p]",
    "",
  ].join("\n");
  assert.deepEqual(read(text), [
    "1: &a -> 1",
    "2: &b-2 -> 2",
    "4: *a -> 1",
    "4: *b-2 -> 2",
    "5: &p -> 5",
    "5: *p -> 5",
  ]);
});

// The offsets become editor positions, which count UTF-16 units from the start
// of the text: a BOM, a CRLF and a character outside the BMP each move them,
// and the lexer's own markers must not.
test("offsets are the text's own", () => {
  const text = "\u{FEFF}a: \u{1F600}\r\nb: &x 1\r\nc: *x\r\n";
  assert.deepEqual(anchorMentions(text), [
    { start: 11, end: 13, anchor: 11 },
    { start: 20, end: 22, anchor: 11 },
  ]);
  assert.equal(text.slice(11, 13), "&x");
  assert.equal(text.slice(20, 22), "*x");
});
