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

.DEFAULT_GOAL := help
.PHONY: help build test lint notices pins config dogfood smoke probe e2e gates \
	version grammars bump control clean

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

smoke: build ## LSP handshake and formatting over stdio
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

# poly-editor has no daemon and no extension host to run in, so its logic
# lives in modules that do not import vscode and is tested with node's own
# runner -- no new dependency, and no half-minute boot to find a typo. The
# package step is the other half: a manifest VSCode would reject is not
# something to discover during a release.
editor: ## Typecheck, test, build and package poly-editor
	cd extensions/editor && pnpm run typecheck && pnpm test && pnpm run build && \
		pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository

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
grammars: ## Generated syntax files match sources.json; grammars tokenize
	python3 tools/grammar-sync.py --check
	@mkdir -p /tmp/poly-tokdeps
	@test -d /tmp/poly-tokdeps/node_modules/vscode-textmate || ( \
		pnpm --dir /tmp/poly-tokdeps init >/dev/null && \
		pnpm --dir /tmp/poly-tokdeps add vscode-textmate vscode-oniguruma >/dev/null )
	node tools/tokenize-check.mjs /tmp/poly-tokdeps/node_modules

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
gates: lint test notices pins config smoke dogfood version probe go tf rust deadcode grammars e2e editor ## Everything above, grouped as CI's jobs are
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
