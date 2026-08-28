.POSIX:
.DEFAULT_GOAL := check

CARGO ?= cargo
TARGETS := x86_64-unknown-linux-gnu aarch64-apple-darwin
GRAMMARS := $(wildcard extensions/syntax/syntaxes/*.tmLanguage.json)
NODE_MODULES := $(shell npm root)

.PHONY: check fmt sync clean $(TARGETS)

check: fmt
	$(CARGO) test --workspace --release
	node tools/tokenize-check.mjs $(NODE_MODULES)

fmt:
	cd cli && $(CARGO) fmt --check

sync: grammars/sources.json
	python3 tools/grammar-sync.py
	git diff --exit-code

$(TARGETS):
	$(CARGO) build --release --locked --target $@

clean:
	rm -rf cli/target extensions/*/node_modules
	@echo "removed $(words $(GRAMMARS)) grammars? no — build output only"
