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
.PHONY: help build test lint dogfood smoke probe e2e gates version bump control clean

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

e2e: ## Extension tests in a real extension host
	cd extensions/lsp && pnpm test

# Given the binary as well, so this asks the same question CI asks: not just
# whether the files agree with each other, but whether the thing users run
# agrees with them.
version: build ## Check every version string agrees, binary included
	python3 tools/bump.py --check $(POLY)

gates: lint test version dogfood smoke probe e2e ## Everything above, in CI's order
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
