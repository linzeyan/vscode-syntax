#!/usr/bin/env node
// Fixture tokenization check: load the synced grammars with vscode-textmate
// (same engine VSCode uses) and verify each fixture produces real scopes —
// catches broken conversions (svelte yaml->json) without eyeballing an editor.
// Usage: node tools/tokenize-check.mjs <node_modules_dir>
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NM = process.argv[2];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "syntax");
const FIXTURES = join(ROOT, "grammars", "fixtures");

const vsctmMod = await import(pathToFileURL(join(NM, "vscode-textmate", "release", "main.js")));
const onigMod = await import(pathToFileURL(join(NM, "vscode-oniguruma", "release", "main.js")));
const vsctm = vsctmMod.default ?? vsctmMod;
const oniguruma = onigMod.default ?? onigMod;
const wasm = readFileSync(join(NM, "vscode-oniguruma", "release", "onig.wasm"));

const pkg = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));
const byScope = new Map();
const injections = new Map(); // injectTo scope -> [injection scopeNames]
for (const g of pkg.contributes.grammars) {
  byScope.set(g.scopeName, join(EXT, g.path));
  for (const target of g.injectTo ?? []) {
    if (!injections.has(target)) injections.set(target, []);
    injections.get(target).push(g.scopeName);
  }
}

const registry = new vsctm.Registry({
  onigLib: oniguruma.loadWASM(wasm.buffer).then(() => ({
    createOnigScanner: (s) => new oniguruma.OnigScanner(s),
    createOnigString: (s) => new oniguruma.OnigString(s),
  })),
  loadGrammar: async (scopeName) => {
    const path = byScope.get(scopeName);
    if (!path) return null; // embedded scopes we don't bundle (source.js etc.)
    return vsctm.parseRawGrammar(readFileSync(path, "utf8"), path);
  },
  getInjections: (scopeName) => injections.get(scopeName) ?? [],
});

// fixture -> [initial scope, required scope substrings, minimum % of tokens
// carrying a scope beyond the root]. The percentage is a smoke signal that the
// grammar engaged at all; a few upstream grammars legitimately scope very
// little, so they carry their own floor rather than padding the fixture.
const CASES = {
  "sample.rs": ["source.rust", ["keyword.operator.arrow.skinny.rust"]],
  "sample.swift": ["source.swift", ["keyword"]],
  "sample.cs": ["source.cs", ["keyword"]],
  "sample.lua": ["source.lua", ["keyword"]],
  "sample.go": ["source.go", ["keyword"]],
  "sample.c": ["source.c", ["keyword"]],
  "sample.cpp": ["source.cpp", ["keyword"]],
  "sample.xml": ["text.xml", ["entity.name.tag"]],
  "sample.yaml": ["source.yaml", ["entity.name.tag.yaml", "string"]],
  "sample.toml": ["source.toml", ["support.type.property-name", "string"]],
  "sample.md": [
    "text.html.markdown",
    [
      "markup.heading",
      "meta.embedded.block.mermaid",
      "meta.embedded.block.graphql",
      "meta.embedded.math.markdown",
      "markup.math.inline",
    ],
  ],
  "sample.sql": ["source.sql", ["keyword"]],
  "Dockerfile": ["source.dockerfile", ["keyword"]],
  "sample.sh": ["source.shell", ["keyword", "string"]],
  "sample.tf": ["source.hcl.terraform", ["entity.name", "string"]],
  "nginx.conf": ["source.nginx", ["keyword", "string"]],
  "sample.zig": ["source.zig", ["keyword", "string"]],
  "sample.gotmpl": ["source.go-template", ["punctuation", "keyword"]],
  "sample.env": ["source.env", ["variable", "string"]],
  "sample.proto": ["source.proto", ["keyword", "string"]],
  "sample.mmd": ["source.mermaid", ["keyword"]],
  "sample.graphql": ["source.graphql", ["keyword", "support.type.graphql"]],
  "sample.svelte": [
    "source.svelte",
    ["entity.name.tag", "keyword", "punctuation.definition.tag"],
  ],
  "sample.csv": ["source.csv", ["rainbow1", "rainbow2", "rainbow3", "punctuation.separator.comma"]],
  "sample.tsv": ["source.tsv", ["rainbow1", "rainbow2", "punctuation.separator.tab"]],
  "sample.ssh_config": [
    "source.ssh-config",
    [
      "keyword.control.ssh-config",
      "entity.name.section.ssh-config",
      "keyword.other.ssh-config",
      "constant.language.ssh-config",
      "constant.numeric.ssh-config",
      "constant.character.escape.ssh-config",
      "string.quoted.double.ssh-config",
      "comment.line.number-sign.ssh-config",
    ],
  ],
  // Batch 2: the requirements name sub-grammars (jsdoc, regexp, sassdoc) and
  // embedded scopes, so a missing file in sources.json fails here, not in an
  // editor — the aggregate grammar still loads without them.
  "sample.js": [
    "source.js",
    ["comment.block.documentation.js", "variable.other.jsdoc", "string.regexp.js", "meta.template.expression"],
  ],
  "sample.jsx": [
    "source.js.jsx",
    ["entity.name.tag.js.jsx", "meta.embedded.expression.js.jsx", "entity.other.attribute-name"],
  ],
  "sample.ts": [
    "source.ts",
    ["comment.block.documentation.ts", "variable.other.jsdoc", "meta.type.annotation", "storage.type.interface"],
  ],
  "sample.tsx": [
    "source.tsx",
    ["entity.name.tag.tsx", "meta.embedded.expression.tsx", "meta.type.parameters", "support.class.component"],
  ],
  "sample.json": ["source.json", ["support.type.property-name", "constant.numeric.json", "constant.character.escape"]],
  "sample.jsonc": [
    "source.json.comments",
    ["comment.line.double-slash", "comment.block.json", "support.type.property-name"],
  ],
  "sample.jsonl": ["source.json.lines", ["support.type.property-name", "string.json.lines"]],
  "sample.code-snippets": [
    "source.json.comments.snippets",
    ["meta.insertion.tabstop", "meta.insertion.variable", "keyword.operator.insertion"],
  ],
  "sample.css": [
    "source.css",
    ["support.type.property-name", "keyword.control.at-rule", "constant.other.color", "meta.attribute-selector.css"],
  ],
  "sample.scss": [
    "source.css.scss",
    ["variable.scss", "variable.other.sassdoc", "variable.interpolation.scss", "keyword.control.at-rule.mixin"],
  ],
  "sample.less": [
    "source.css.less",
    ["support.other.variable", "keyword.control.at-rule", "constant.other.color", "meta.function-call.less"],
  ],
  // source.js / source.css here prove the embedded blocks resolve against the
  // grammars we ship, not against VSCode's own copies.
  "sample.html": [
    "text.html.derivative",
    ["entity.name.tag.html", "meta.embedded.block.html", "meta.property-name.css", "storage.type.function"],
  ],
  "sample.py": [
    "source.python",
    ["meta.fstring.python", "string.regexp.quoted", "entity.name.tag.named.group.regexp", "meta.function.decorator"],
  ],
  // Batch 2 remainder: the rest of the built-in languages. Where a grammar
  // embeds another, the requirement names the embedded scope, which only
  // resolves because poly now ships that grammar too.
  "sample.java": [
    "source.java",
    ["comment.block.javadoc", "storage.modifier.permits", "string.quoted.triple", "meta.record.java"],
  ],
  "sample.php": [
    "text.html.php",
    [
      "meta.embedded.block.php",
      "meta.embedded.sql",
      "source.js",
      "entity.name.tag.html",
      "comment.block.documentation.phpdoc.php",
    ],
  ],
  "sample.rb": [
    "source.ruby",
    ["string.regexp.interpolated.ruby", "meta.embedded.line.ruby", "constant.other.symbol", "keyword.control.def"],
  ],
  "sample.ps1": [
    "source.powershell",
    ["comment.documentation.embedded.powershell", "support.variable.automatic", "meta.attribute.powershell"],
  ],
  "sample.ini": [
    "source.ini",
    ["entity.name.section", "keyword.other.definition", "comment.line.semicolon", "comment.line.number-sign"],
  ],
  "sample.bat": [
    "source.batchfile",
    ["keyword.command.batchfile", "variable.parameter.batchfile", "keyword.operator.redirection", "comment.line.rem"],
  ],
  "Makefile": [
    "source.makefile",
    ["support.function.shell", "variable.other.makefile", "meta.scope.recipe", "string.interpolated.makefile"],
  ],
  "sample.pl": [
    "source.perl",
    ["string.regexp.compile", "variable.other.predefined", "keyword.control.perl", "constant.other.bareword"],
  ],
  "sample.r": ["source.r", ["support.function.r", "keyword.control.r", "constant.language.r", "meta.function.r"]],
  "sample.jl": [
    "source.julia",
    ["string.docstring.julia", "support.function.macro", "keyword.storage.modifier", "variable.interpolation.julia"],
  ],
  "sample.tex": [
    "text.tex.latex",
    ["support.function.section", "meta.math.block", "meta.embedded.block.generic.latex", "constant.other.reference"],
  ],
  "sample.m": [
    "source.objc",
    ["support.class.cocoa", "meta.interface-or-protocol.objc", "keyword.other.property", "string.quoted.other"],
  ],
  "sample.pug": [
    "text.pug",
    ["entity.name.tag.pug", "meta.embedded.line.js", "meta.property-name.css", "string.interpolated.pug"],
  ],
  "sample.hbs": [
    "text.html.handlebars",
    [
      "meta.function.block",
      "support.constant.handlebars",
      "comment.block.handlebars",
      "entity.name.tag.block.any.html",
    ],
  ],
  "sample.diff": [
    "source.diff",
    ["markup.inserted.diff", "markup.deleted.diff", "meta.diff.range", "meta.diff.header"],
  ],
  "COMMIT_EDITMSG": ["text.git-commit", ["meta.scope.subject", "meta.scope.metadata", "comment.line.number-sign"]],
  "git-rebase-todo": [
    "text.git-rebase",
    ["support.function.git-rebase", "constant.sha.git-rebase", "meta.commit-message.git-rebase"],
  ],
  // Upstream's ignore grammar is a single rule: comments. Nothing else is
  // meant to be scoped, so the usual floor would fail a working grammar.
  "sample.gitignore": ["source.ignore", ["comment.line.number-sign.ignore"], 10],
  "sample.log": ["text.log", ["log.error", "log.date", "log.info", "log.exception"]],
  "sample.dart": [
    "source.dart",
    [
      "comment.block.documentation.dart",
      "meta.embedded.expression.dart",
      "storage.type.annotation",
      "support.class.dart",
    ],
  ],
  "sample.groovy": [
    "source.groovy",
    ["source.groovy.embedded.source", "storage.type.annotation", "meta.method.groovy", "variable.other.interpolated"],
  ],
  "sample.clj": [
    "source.clojure",
    ["constant.keyword.clojure", "string.regexp.clojure", "entity.global.clojure", "meta.metadata.simple"],
  ],
  "sample.coffee": [
    "source.coffee",
    ["string.regexp.coffee", "source.coffee.embedded.source", "keyword.operator.existential", "meta.class.coffee"],
  ],
  "sample.fs": [
    "source.fsharp",
    ["keyword.symbol.arrow", "record.fsharp", "namespace.open.fsharp", "entity.name.type"],
  ],
  "sample.vb": [
    "source.asp.vb.net",
    ["keyword.control.asp", "storage.type.asp", "support.function.vb", "constant.language.asp"],
  ],
  "sample.hlsl": [
    "source.hlsl",
    ["support.type.texture", "support.variable.semantic", "storage.type.basic", "support.function.hlsl"],
  ],
  "sample.shader": [
    "source.shaderlab",
    ["meta.cgblock", "support.type.propertyname", "keyword.preprocessor.hlsl", "support.function.hlsl"],
  ],
  "sample.cshtml": [
    "text.html.cshtml",
    ["keyword.control.razor", "source.cs", "source.css", "meta.embedded.line.js", "entity.name.tag.html"],
  ],
  "sample.rst": [
    "source.rst",
    ["markup.heading", "meta.function.python", "support.function.builtin", "entity.name.tag.anchor"],
  ],
  "sample.prompt.md": [
    "text.html.markdown.prompt",
    ["meta.embedded.block.frontmatter", "meta.embedded.block.shellscript", "markup.heading.markdown"],
  ],
  // Batch 2 additions: languages VSCode has no grammar for at all.
  "sample.vue": [
    "text.html.vue",
    [
      "entity.name.tag.template.html.vue",
      "source.ts.embedded.html.vue",
      "meta.property-name.css",
      "meta.attribute.directive",
      "expression.embedded.vue",
    ],
  ],
  "sample.kt": [
    "source.kotlin",
    ["comment.block.javadoc", "keyword.hard.fun", "meta.template.expression", "entity.name.package"],
  ],
  "CMakeLists.txt": [
    "source.cmake",
    ["support.function.cmake", "keyword.control.conditional", "variable.other.cmake", "constant.language.boolean"],
  ],
  "CMakeCache.txt": [
    "source.cmakecache",
    ["support.variable.cmakecache", "constant.language.cmakecache", "comment.line.double-slash"],
  ],
  "sample.jsonnet": [
    "source.jsonnet",
    ["keyword.other.jsonnet", "entity.name.function", "comment.line.jsonnet", "variable.parameter.jsonnet"],
  ],
  // source.python here is the shebang recipe body: just declares the embedding
  // and poly supplies the grammar it names.
  "justfile": [
    "source.just",
    ["keyword.operator.recipe", "variable.other.just", "source.python", "keyword.operator.path-join"],
  ],
  "sample.nix": [
    "source.nix",
    ["keyword.other.inherit", "punctuation.section.embedded.begin.nix", "string.unquoted.path", "support.function.nix"],
  ],
  "Caddyfile": [
    "source.Caddyfile",
    ["support.function.Caddyfile", "keyword.control.caddyfile", "comment.line.Caddyfile", "support.constant.Caddyfile"],
  ],
  "sample.service": [
    "source.systemd",
    [
      "entity.name.section",
      "meta.config-entry.systemd",
      "keyword.operator.assignment",
      "punctuation.definition.variable",
    ],
  ],
  "sample.scala": [
    "source.scala",
    ["comment.block.documentation.scala", "meta.embedded.line.scala", "keyword.declaration.scala", "entity.name.class"],
  ],
  "sample.htaccess": [
    "source.apacheconf",
    ["entity.tag.apacheconf", "keyword.rewrite.apacheconf", "string.regexp.apacheconf", "keyword.headers.apacheconf"],
  ],
  "sample.ex": [
    "source.elixir",
    [
      "comment.block.documentation.heredoc",
      "keyword.operator.sigils_1",
      "meta.embedded.line.elixir",
      "constant.other.keywords",
    ],
  ],
  "sample.erl": [
    "source.erlang",
    [
      "meta.directive.module",
      "meta.macro-usage.erlang",
      "meta.structure.record",
      "punctuation.separator.clause-head-body",
    ],
  ],
  "sample.hs": [
    "source.haskell",
    [
      "comment.block.documentation.haskell",
      "keyword.other.module",
      "meta.declaration.data",
      "keyword.operator.double-colon",
    ],
  ],
  "sample.cabal": ["source.cabal", ["entity.name.section", "keyword.other.cabal", "keyword.operator.cabal"]],
  "sample.ml": [
    "source.ocaml",
    ["comment.block.ocaml", "keyword.other.ocaml", "string.quoted.braced", "support.type.ocaml"],
  ],
  "sample.mli": ["source.ocaml.interface", ["comment.doc.ocaml", "keyword.other.ocaml", "support.type.ocaml"]],
  "dune": ["source.dune", ["keyword.language.dune", "comment.line.dune", "variable.other.declaration"]],
  "dune-project": [
    "source.dune-project",
    ["keyword.language.dune-project", "constant.language.dune", "variable.other.declaration"],
  ],
  "sample.opam": ["source.ocaml.opam", ["entity.name.tag.opam", "keyword.operator.opam", "variable.parameter.opam"]],
  // Jinja variants layer template delimiters over a host grammar, so both have
  // to show up.
  "sample.html.j2": [
    "text.html.jinja",
    ["keyword.control.jinja", "variable.other.jinja", "comment.block.jinja", "entity.name.tag.html"],
  ],
  "sample.py.j2": [
    "source.python.jinja",
    ["keyword.control.jinja", "variable.other.jinja", "meta.function.python", "string.quoted.docstring"],
  ],
  // Deliberately host-only: see the jinja-yaml rationale in sources.json. If a
  // future yaml grammar stops claiming the whole document this starts failing,
  // which is the signal to add the jinja requirements back.
  "sample.yaml.j2": ["text.yaml.jinja", ["entity.name.tag.yaml", "meta.mapping.yaml"]],
};

let failed = 0;
for (const [file, [scopeName, required, minPct = 30]] of Object.entries(CASES)) {
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) {
    console.log(`FAIL ${file}: grammar ${scopeName} not loadable`);
    failed++;
    continue;
  }
  const lines = readFileSync(join(FIXTURES, file), "utf8").split("\n");
  const seen = new Set();
  let ruleStack = vsctm.INITIAL;
  let tokens = 0;
  let scoped = 0; // tokens with more than just the root scope
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, ruleStack);
    ruleStack = r.ruleStack;
    for (const t of r.tokens) {
      tokens++;
      if (t.scopes.length > 1) scoped++;
      for (const s of t.scopes) seen.add(s);
    }
  }
  const missing = required.filter((sub) => ![...seen].some((s) => s.includes(sub)));
  const pct = tokens ? Math.round((100 * scoped) / tokens) : 0;
  if (missing.length || pct < minPct) {
    failed++;
    console.log(`FAIL ${file}: ${pct}% tokens scoped; missing: ${missing.join(", ") || "-"}`);
    console.log(`     scopes seen: ${[...seen].slice(0, 20).join(" ")}`);
  } else {
    console.log(`ok   ${file}: ${pct}% tokens scoped, ${seen.size} distinct scopes`);
  }
}
console.log(failed ? `\n${failed} FAILURES` : "\nall fixtures pass");

// ── language-configuration probes ──────────────────────────────────────────
// M1's manual checklist ("toggle comment works") as a gate instead: the comment
// token we hand VSCode must be the one the grammar we ship treats as a comment.
// When they disagree, Ctrl+/ inserts text the highlighter then paints as code,
// and nothing above notices — the fixture pass loads grammars by scopeName, so
// it never exercises the language id or the configuration file at all.
const scopeOf = new Map();
for (const g of pkg.contributes.grammars) {
  if (g.language && !scopeOf.has(g.language)) scopeOf.set(g.language, g.scopeName);
}
// Grammars whose comment rules only exist inside a construct; the probe needs
// to get there first. Keep this list short and say why each entry is here.
const PREAMBLE = {
  // Every rule in the mermaid grammar hangs off a diagram declaration.
  mermaid: ["graph TD"],
};

let cfgFailed = 0;
for (const lang of pkg.contributes.languages) {
  const scopeName = scopeOf.get(lang.id);
  if (!scopeName) {
    // A contributed language with no grammar bound to its id opens with no
    // highlighting whatsoever, which is the whole point of this extension.
    console.log(`FAIL ${lang.id}: no grammar contributes language "${lang.id}"`);
    cfgFailed++;
    continue;
  }
  // An entry that only adds file associations to a built-in — shellscript
  // gaining .bats — ships no configuration of its own. VSCode keeps the
  // built-in's, so there is no file here that could disagree with the grammar,
  // which is the only thing the probe below is looking for.
  if (!lang.configuration) continue;
  const cfgPath = join(EXT, lang.configuration.replace(/^\.\//, ""));
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e) {
    console.log(`FAIL ${lang.id}: ${lang.configuration}: ${e.message}`);
    cfgFailed++;
    continue;
  }
  if (!cfg.comments) continue;
  const grammar = await registry.loadGrammar(scopeName);
  const probes = [];
  if (cfg.comments.lineComment) probes.push(`${cfg.comments.lineComment} poly probe`);
  if (cfg.comments.blockComment) {
    const [open, close] = cfg.comments.blockComment;
    probes.push(`${open} poly probe ${close}`);
  }
  for (const probe of probes) {
    let ruleStack = vsctm.INITIAL;
    let sawComment = false;
    for (const line of [...(PREAMBLE[lang.id] ?? []), probe]) {
      const r = grammar.tokenizeLine(line, ruleStack);
      ruleStack = r.ruleStack;
      if (line === probe) {
        sawComment = r.tokens.some((t) => t.scopes.some((s) => s.includes("comment")));
      }
    }
    if (!sawComment) {
      console.log(`FAIL ${lang.id}: ${JSON.stringify(probe)} is not a comment in ${scopeName}`);
      cfgFailed++;
    }
  }
}
console.log(
  cfgFailed
    ? `${cfgFailed} language-configuration FAILURES`
    : `all ${pkg.contributes.languages.length} language configurations agree with their grammar`,
);

process.exit(failed || cfgFailed ? 1 : 0);
