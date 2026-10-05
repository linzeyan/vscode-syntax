# The commands this repo is actually developed with. Every target here mirrors
# something ci.yml runs, so a green `make gates` means a push has already been
# checked the way CI will check it -- the point is to stop rediscovering the
# invocations, not to invent a second build system.
#
# Recipes run under /bin/sh, so the interactive shell's aliases and noclobber
# do not apply here even though they bite when the same commands are pasted
# into a terminal.

POLY := cli/target/release/poly
# --manifest-path belongs to the subcommand rather than to cargo itself, so it
# is appended after the verb instead of folded into a `cargo ...` variable.
MANIFEST := --manifest-path cli/Cargo.toml

# The release profile ships fat LTO and codegen-units = 1, which is right for
# the binary users install and wrong for every build made here: measured on this
# tree, a one-line change cost 111s before these two overrides and 2s after.
# Almost none of that was compiling -- touching poly-cli and touching poly-core
# both cost about 115s, because what is being paid for is a whole-program relink
# of a 30MB binary rather than the crate that changed.
#
# ci.yml sets exactly these two, at the top, for exactly this reason: nothing
# either of us builds is what ships. build.yml and release.yml compile the
# profile as written, and that is what users install. So this is CI's override,
# local, and a green `make gates` is still CI's answer to the same question.
#
# `make build CARGO_PROFILE_RELEASE_LTO=fat` gets the shipping profile back for
# a size or throughput measurement. It rebuilds every dependency, which is why
# it is a flag rather than the default.
CARGO_PROFILE_RELEASE_LTO ?= false
CARGO_PROFILE_RELEASE_CODEGEN_UNITS ?= 16
export CARGO_PROFILE_RELEASE_LTO CARGO_PROFILE_RELEASE_CODEGEN_UNITS

.DEFAULT_GOAL := help
.PHONY: help build test lint notices pins config dogfood smoke probe e2e gates \
	version grammars tokdeps grammar-diff grammar-fuzz grammar-corpus grammar-real editor-diff ext-diff mermaid-diff engine-diff \
	lsp-fmt-diff ref-lens lens-probe toc-fuzz list-fuzz gutter-cache git-embed bump control clean syntax

help: ## List targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Release build of the poly binary
	cargo build --release $(MANIFEST)

test: ## Rust unit and integration tests
	cargo test --workspace --release $(MANIFEST)

lint: ## rustfmt and clippy, both as CI runs them
	cargo fmt --all $(MANIFEST) -- --check
	cargo clippy --all-targets $(MANIFEST) -- -D warnings

# Both are drift gates, and drift gates never fail on the machine that caused
# the drift -- the notices file is regenerated from cargo metadata and the tool
# lock from the registry, so whoever adds a dependency has both already right.
# They fail for whoever pulls next, which is why they belong in a local gate.
notices: ## THIRD-PARTY-NOTICES still matches cargo metadata
	python3 tools/third-party-notices.py --self-test
	python3 tools/third-party-notices.py --check

# Offline on purpose: it compares the lock against the registry, nothing
# upstream. A hand-edited version pin leaves every platform but this one on
# trust-on-first-use, which looks exactly like a pin until someone downloads.
pins: ## External tool versions and hashes are locked
	python3 tools/tool-sync.py --check

# The third drift gate, and the one whose failure mode is documentation rather
# than a build: poly.example.toml is generated, so a tool poly pins or embeds
# cannot quietly stop matching what the file says it does.
#
# --self-test first, for the same reason the notices gate has one. This compares
# the binary against a file the binary wrote, so a generator that silently
# stopped substituting would be regenerated into the committed copy and pass
# from then on. A gate that stops working is worse than no gate.
config: build ## poly.example.toml still matches what `poly config export` writes
	$(POLY) config export --self-test
	$(POLY) config export | diff -u poly.example.toml -

# poly run over its own repo. --strict so a missing toolchain fails here rather
# than quietly formatting less than a developer's machine does.
dogfood: build ## poly formats and lints its own repo
	$(POLY) fmt --check .
	$(POLY) check --strict .

smoke: build ## LSP handshake, formatting and a memory soak over stdio
	python3 tools/lsp-smoke.py $(POLY)

# Skips a language whose server is not installed and says so. CI installs five
# of the six and asserts they are present, because a check that only ever skips
# is a check nobody is running.
probe: build ## Language server proxy, against whichever servers are installed
	python3 tools/lsp-proxy-probe.py $(POLY)

# Its own target rather than more of `probe`: this one is about gofumpt and
# golangci-lint, which is `poly check`'s side of Go and not the proxy's, and it
# needs a Go toolchain rather than a language server.
go: build ## poly's Go support end to end: gofumpt, golangci-lint, editor vs CI
	python3 tools/go-acceptance.py $(POLY)

# The other whole-directory linter, and the only one whose scopes nest by
# default. Needs no toolchain at all: poly downloads tflint, and its bundled
# ruleset wants neither `tflint --init` nor `terraform init`.
tf: build ## poly's Terraform lint end to end: editor vs CI, and nested modules
	python3 tools/tf-acceptance.py $(POLY)

# The third whole-scope linter, and the only one that compiles to answer. Skips
# loudly without cargo or the clippy component; the fixture has no dependencies
# so the compile it does need is seconds, not minutes.
rust: build ## poly's Rust lint end to end: editor vs CI, workspace scope, no duplicates
	python3 tools/rust-acceptance.py $(POLY)

# The Go half of `poly deadcode` is inside `make go`, where it has a go.work
# control. This is knip and vulture; each skips loudly without its tool.
deadcode: build ## poly deadcode outside Go: knip paths resolve, vulture stays out of the venv
	python3 tools/deadcode-acceptance.py $(POLY)

# typecheck first, same as CI: the extension host takes half a minute to boot,
# and a type error does not need it.
e2e: ## Typecheck and run the extension tests in a real extension host
	cd extensions/lsp && pnpm run typecheck && pnpm test

# The editor features need no daemon, so their logic lives in modules that do
# not import vscode and is tested with node's own runner -- no new dependency,
# and no half-minute boot to find a typo. The package step is the other half: a
# manifest VSCode would reject is not something to discover during a release.
editor: ## Unit-test the editor features, then build and package the extension
	cd extensions/lsp && pnpm run typecheck && pnpm run unit && pnpm run build && \
		pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
	python3 tools/vsix-check.py extensions/lsp

# poly-syntax-highlight's one script, the update check it shares with Poly.
# Packaged as well, so vsix-check sees the bundle `main` points at: the
# grammars alone never needed a build, and a VSIX without it installs fine
# and checks for nothing.
syntax: ## Typecheck, build and package poly-syntax-highlight
	cd extensions/syntax && pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run build && \
		pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
	python3 tools/vsix-check.py extensions/syntax

# A gate and not an audit, unlike the *-diff targets: it asserts about poly
# alone, and the only real provider it asks -- TypeScript's -- ships inside the
# editor, so there is nothing to download but VSCode itself, which `e2e` already
# has. The protobuf and shell sections have no offline server to ask, so they
# supply providers shaped like what `make lens-probe` measured; that pins poly's
# wiring, and `lens-probe` is what says the real servers still behave that way.
# GraphQL and nginx are answered by poly's own daemon, hence the build.
#
# It exists because `make editor`'s unit tests could not see the defect that
# put a count over every parameter and local: they assert against a symbol tree
# written by the same hand as the rule, and the rule was wrong about what a
# real server reports. Every lens added since is checked here for that reason.
ref-lens: build ## Where poly's code lenses land, in a real extension host
	node tools/ref-lens-check/run.js

# The table of contents command's anchors against the ones the preview writes,
# for a corpus of headings that is half stated rules and half generated
# punctuation. A gate for the same reason ref-lens is: the reference is the
# editor's own renderer, reached through `markdown.api.render`, and nothing is
# downloaded that `e2e` has not already downloaded.
#
# It earned its place on the first run: 134 of 448 anchors did not match, in a
# module whose comment claimed its slugifier was VSCode's "transcribed
# character for character". The unit tests could not see it -- they assert
# against examples written by whoever wrote the rule.
toc-fuzz: ## Heading anchors against the ones VSCode's own preview writes
	node tools/toc-fuzz/run.js

# What Tab, Shift+Tab and Enter do to a list, against `poly fmt`. A gate rather
# than an audit because the reference is this repo's own binary: no VSCode, no
# network, one process for the whole corpus.
#
# It earned its place on its first run too, with six defects the unit tests
# could not see -- starting with Tab moving an item's marker and leaving its
# children behind, at a column that made them somebody else's.
list-fuzz: build ## List keystrokes against the formatter that has to accept them
	node tools/list-fuzz/run.js

# The gutter thumbnail cache, counted rather than argued about. No editor here
# either: `previewImages` is driven against a stub of the API it uses, which is
# the only way to ask a question whose answer is a number after a thousand
# repaints.
#
# It earned its place the way the two above did. The cache was keyed by image
# path and never evicted, so a session that scrolled 400 images past a 20-line
# window kept 400 decoration types and set every one of them on every repaint --
# under a comment claiming it was "bounded because a file only has so many
# visible lines".
gutter-cache: ## The image gutter cache stays the size of what is on screen
	node tools/gutter-cache-check.js

# Where there is no git, Git History hands its questions to `poly git`. Every
# view, details pane, comparison and tag it reads, through each, compared on the
# fixtures git-graph-diff builds (exactly) and on this checkout's own history
# (up to git's rename and line-split heuristics; see the script). Name more
# repositories to check them instead: `node tools/git-embed-check.js <repo>...`.
git-embed: ## Git History reads the same through poly git as through git
	node tools/git-embed-check.js

# The offline half of ci.yml's grammars job. The other half re-fetches every
# pinned grammar, which needs the network and a token; what stays here is
# everything downstream of that -- and it is where the failures actually are.
# This target exists because it was missing: a hand edit to the generated
# extensions/syntax/package.json passed a full green `make gates` twice and
# failed in CI twice, which made this file's opening claim untrue.
#
# The tokenizer deps go to /tmp rather than into the repo: they are two
# packages this repo does not otherwise depend on, and pnpm has them cached
# after the first run.
#
# The manifest is written rather than `pnpm init`ed. pnpm 11 writes a
# `devEngines.packageManager` block pinned to `^<the version that ran init>`
# with `onFail: download`, so the very next pnpm command in that directory
# fetches whatever 11.x is newest and runs the check on a pnpm nothing here
# pinned -- and when that download is half-written, the failure is
# `pnpm: line 1: This: command not found`, which names neither pnpm nor this
# target. Two keys are all `pnpm add` needs.
grammars: tokdeps ## Generated syntax files match sources.json; grammars tokenize
	python3 tools/grammar-sync.py --check
	node tools/tokenize-check.mjs /tmp/poly-tokdeps/node_modules

# Cheap and static, so it runs with the other drift gates rather than behind an
# editor. Neither failure it catches is visible without reading the settings UI
# in two locales: an unresolved %key% renders as itself, and a missing
# translation falls back to English.
nls: ## Every %key% in a manifest resolves, in every locale
	python3 tools/nls-check.py

# The guard asks for the files the check imports, not for the directory that
# holds them, and repairs by starting over. macOS prunes /tmp by age and leaves
# the tree behind: a `test -d` on the package saw two empty `release/`
# directories, called the deps installed, and `make gates` failed mid-release on
# ERR_MODULE_NOT_FOUND rather than on anything in this repo. `pnpm add` will not
# mend that tree either -- the store link is still there, so it reports the
# package present and writes nothing back. Measured: after deleting one file,
# `pnpm add` left it deleted.
TOKDEPS_ENTRY = /tmp/poly-tokdeps/node_modules/vscode-textmate/release/main.js
TOKDEPS_WASM = /tmp/poly-tokdeps/node_modules/vscode-oniguruma/release/onig.wasm

tokdeps:
	@test -s $(TOKDEPS_ENTRY) && test -s $(TOKDEPS_WASM) || ( \
		rm -rf /tmp/poly-tokdeps && mkdir -p /tmp/poly-tokdeps && \
		printf '{"name":"poly-tokdeps","private":true}\n' > /tmp/poly-tokdeps/package.json && \
		pnpm --dir /tmp/poly-tokdeps add vscode-textmate vscode-oniguruma >/dev/null )

# The two differential audits. Neither is in `gates`, and the reason is the same
# for both: they compare poly against software this repo does not ship. One
# needs a VSCode installation to read the built-in grammars out of, the other
# downloads the replaced extensions from the marketplace. A gate that goes red
# because somebody upgraded their editor is a gate people learn to ignore.
#
# What they answer is the question no fixture can: `tokenize-check` and
# the editor features' unit tests both only ever ask poly what it thinks.
# These ask the thing poly replaced the same question and compare the answers.
#
# VSCODE_EXTENSIONS overrides which installation is the reference; running it
# against two versions is how an upstream improvement is told apart from a
# regression, because a real regression survives both.
grammar-diff: tokdeps ## poly's grammars against the built-ins they take over
	node tools/grammar-diff.mjs /tmp/poly-tokdeps/node_modules "$(VSCODE_EXTENSIONS)"

# The same two sides, asked what they do with input nobody would write. An
# audit for the same reason as grammar-diff -- the reference is an editor this
# repo does not ship -- and it takes two minutes, which is a minute and a half
# more than any gate here.
#
# It reads the pass line off the editor rather than inventing one: VSCode gives
# a line a time limit and paints the remainder as plain text when it runs out,
# so a grammar fails when it would cost a reader their highlighting. Findings
# the built-in of the same name shares are upstream's and reported; the ones
# from grammars poly ships alone are listed by name in the tool, with a reason
# each, and anything new is red.
grammar-fuzz: tokdeps ## What the grammars do with input nobody would write on purpose
	node tools/grammar-fuzz.mjs /tmp/poly-tokdeps/node_modules "$(VSCODE_EXTENSIONS)"

# The same comparison over VSCode's own colorize fixtures -- the files it
# tokenizes in its own tests, most of them named for the issue number of a
# highlighting bug somebody reported. Its own target because this one needs the
# network, where `grammar-diff` needs only an installed editor.
#
# It earned the extra target on its first run: two fixtures it flagged were the
# comparison's fault rather than poly's, and fixing that found a case the
# repo's own fixtures could not reach.
grammar-corpus: tokdeps ## grammar-diff over VSCode's own colorize fixtures (downloads them)
	POLY_DIFF_CORPUS="$$(node tools/colorize-corpus.mjs)" \
		node tools/grammar-diff.mjs /tmp/poly-tokdeps/node_modules "$(VSCODE_EXTENSIONS)"

# And the same again over ordinary source files, sampled from a tree on this
# machine. The other three corpora are all written to be interesting -- one
# representative file per language, constructs that only matter when two
# grammars are compared, files that broke a grammar badly enough to be filed as
# an issue. None of them is a thousand lines of somebody's actual code, which is
# where a grammar spends its life.
#
# GRAMMAR_TREE says which tree; there is no default worth committing, so this is
# the one target here that does nothing useful on a machine that is not this one.
#
# It found the audit's own defect on its first run: a markdown file with a C++
# block was reported as repainted by thirteen injections poly adds to markdown,
# none of which has anything to do with C++.
GRAMMAR_TREE ?= $(HOME)/git/resources
grammar-real: tokdeps ## grammar-diff over ordinary source files from GRAMMAR_TREE
	POLY_DIFF_CORPUS="$$(node tools/real-corpus.mjs $(GRAMMAR_TREE))" \
		node tools/grammar-diff.mjs /tmp/poly-tokdeps/node_modules "$(VSCODE_EXTENSIONS)"

editor-diff: ## poly's editor features against the extensions they replace (downloads them)
	node tools/editor-diff/run.js

# The same question asked of the extensions people had installed before poly
# replaced them -- gremlins, a status-bar format toggle, bash-ide -- and of the
# built-in references view poly's lens now opens a tree in place of. It exists
# because features that passed every test here still worked badly in use: the
# tests only ever asked poly, never the thing a user was comparing it with.
#
# Two launches per case set, one with the original and one with poly loaded
# from this checkout's source, so neither side's decorations reach the other's
# screenshots. Each writes results.json and PNG screenshots; .logs/ext-diff-<time>/ gets
# diff.json and an index.html that pairs the pictures with the rows.
#
# Out of `gates` for editor-diff's reason -- it downloads software this repo
# does not ship, and a disagreement is a finding to read rather than a failure.
# It exits non-zero only when a side could not be measured. `POLY=` points it
# at another binary, as it does for the targets that drive this one.
ext-diff: build ## poly against the extensions it replaced, with screenshots (downloads them)
	node tools/ext-diff/run.js $(POLY)

# The other half of ref-lens. What it holds down is the half of the lenses
# that is not poly's code -- five lenses and commands are wired to particular
# code action kinds and to `textDocument/implementation` read backwards, and
# each of those is a claim about gopls that was true when measured. ref-lens
# cannot see any of it: what answers there is TypeScript's provider, which does
# not answer the backwards question at all, and fixtures shaped like what gopls
# and buf were measured to say -- which holds poly's wiring down and says
# nothing about whether they still say it.
#
# It was an audit, on the grounds that CI has neither gopls nor buf. Both halves
# of that were wrong: ci.yml installs a pinned gopls for `probe` in the same
# job, and buf is poly's to download. So it is a gate that skips when the Go
# toolchain is absent, and CI passes `--require` to say that skipping there is
# a failure -- the same contract `probe` already has.
lens-probe: build ## What gopls and buf still offer the lenses poly routes to
	python3 tools/lens-probe.py $(POLY)

# The one differential whose reference ships inside the editor rather than
# beside it: from 1.135 VSCode draws mermaid fences itself, and poly's renderer
# exists for the versions before that. It launches one extension host twice --
# once with the built-in in charge, once with it disabled -- and compares what
# reached the page, so "the same document renders the same on either side of
# 1.135" is measured rather than asserted. Needs a 1.135+ build in
# extensions/lsp/.vscode-test, which `make e2e` downloads.
mermaid-diff: ## poly's mermaid rendering against VSCode's built-in
	node tools/mermaid-diff/run.js

# The preview's other additions against what they replace: GitHub styling
# against bierner.markdown-preview-github-styles installed in a second host,
# the diagram fences against MarkNote's own library calls. Downloads bierner's
# VSIX and reads a MarkNote checkout (MARKNOTE=, default ~/git/MarkNote), so it
# is an audit and not a gate. Writes screenshots beside its report.
preview-diff: ## poly's preview styling and diagram fences against what they replace
	node tools/preview-diff/run.js

# The third differential, and the only one where poly does not replace the
# upstream so much as swallow it: `poly fmt` and `poly check` link their
# engines in as libraries. Every test in this repo therefore asks the engine a
# question through poly, and none of them can tell "poly drives it the way its
# project does" apart from "poly drives it some other way and no fixture
# noticed".
#
# Twelve engines, and only three of them have a CLI to install. For the rest --
# the dprint plugins, the g-plane formatters, mago -- the comparison is against
# the expected output each project keeps beside its own inputs, which is the
# file its CI holds it to. `make engine-diff <name>` is not a thing make does;
# run the script directly to pick one:
#
#     python3 tools/engine-diff.py cli/target/release/poly markup_fmt
#
# Out of `gates` for the same reason as the other two, plus one of its own: it
# clones each project at the tag its version names, so it is the only target
# here that a GitHub outage can turn red.
engine-diff: build ## poly's embedded engines against the projects they embed (clones them)
	python3 tools/engine-diff.py $(POLY)

# The fourth, and the only one with nothing to download and no table of allowed
# differences: both sides are this binary. poly-lsp's whole promise is that the
# editor and CI give one answer, and every other test here asks only one of the
# two paths -- `smoke` drives the daemon, `dogfood` drives the CLI, and neither
# would notice them drifting apart.
#
# Not in `gates` only because that list mirrors ci.yml's jobs; unlike the other
# three this one would run anywhere, and belongs in both once added.
lsp-fmt-diff: build ## `poly lsp` formatting against `poly fmt`, over this repo
	python3 tools/lsp-fmt-diff.py $(POLY)

# Given the binary as well, so this asks the same question CI asks: not just
# whether the files agree with each other, but whether the thing users run
# agrees with them.
version: build ## Check every version string agrees, binary included
	python3 tools/bump.py --check $(POLY)

# The list is ci.yml's: this claims a green run means the push is already
# checked the way CI checks it, and a gate missing from here makes that a lie.
#
# The order is ci.yml's four jobs read end to end -- cli, then acceptance, then
# grammars, then extensions. CI runs them in parallel and a developer cannot, so
# this is the serial reading of the same list rather than the same order; what
# still holds is that a failure here lands on the gate CI would name.
gates: lint test notices pins config nls smoke dogfood version probe lens-probe go tf rust deadcode grammars e2e editor syntax ref-lens gutter-cache git-embed toc-fuzz list-fuzz ## Everything above, grouped as CI's jobs are
	@echo "all gates passed"

# make bump VERSION=0.8.0
#
# poly.example.toml carries the version twice ("read out of poly X.Y.Z itself",
# "the whole set, as of poly X.Y.Z") and bump.py cannot rewrite it: the file is
# generated, and the generator is the binary, which does not exist at the new
# version until after the manifests move. So bump rebuilds and regenerates
# rather than leaving a tree that only `make config` would call wrong -- the
# 0.10.0 bump left exactly that tree and CI found it.
bump: ## Move every version string to VERSION=x.y.z
	@test -n "$(VERSION)" || { echo "usage: make bump VERSION=x.y.z" >&2; exit 1; }
	python3 tools/bump.py $(VERSION)
	cargo build --release --manifest-path cli/Cargo.toml
	$(POLY) config export > poly.example.toml
	python3 tools/bump.py --check $(POLY)

# make control REF=v0.7.0
#
# A behaviour change is only proven by a binary that fails the new check, so
# this builds one from any ref into its own worktree. Kept as a target because
# every round of proxy work has needed it and the worktree dance is easy to get
# wrong -- a control built in the working tree is not a control.
control: ## Build a comparison binary from REF=<git-ref> into /tmp
	@test -n "$(REF)" || { echo "usage: make control REF=<git-ref>" >&2; exit 1; }
	rm -rf /tmp/poly-control-$(REF)
	git worktree add -q --detach /tmp/poly-control-$(REF) $(REF)
	cargo build --release --manifest-path /tmp/poly-control-$(REF)/cli/Cargo.toml
	@echo "control binary: /tmp/poly-control-$(REF)/cli/target/release/poly"
	@echo "remove with: git worktree remove --force /tmp/poly-control-$(REF)"

clean: ## Drop build output and any leftover control worktrees
	cargo clean $(MANIFEST)
	git worktree list --porcelain | awk '/^worktree \/tmp\/poly-control-/ {print $$2}' | \
		xargs -r -n1 git worktree remove --force
