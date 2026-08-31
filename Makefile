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
.PHONY: help build test lint notices pins dogfood smoke probe e2e gates version \
	bump control clean

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

# Given the binary as well, so this asks the same question CI asks: not just
# whether the files agree with each other, but whether the thing users run
# agrees with them.
version: build ## Check every version string agrees, binary included
	python3 tools/bump.py --check $(POLY)

# The order is ci.yml's, so a failure here fails at the same point CI would.
# The list is ci.yml's too: this claims a green run means the push is already
# checked the way CI checks it, and a gate missing from here makes that a lie.
gates: lint test notices pins smoke probe dogfood version e2e editor ## Everything above, in CI's order
	@echo "all gates passed"

# make bump VERSION=0.8.0
bump: ## Move every version string to VERSION=x.y.z
	@test -n "$(VERSION)" || { echo "usage: make bump VERSION=x.y.z" >&2; exit 1; }
	python3 tools/bump.py $(VERSION)

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
