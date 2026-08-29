#!/usr/bin/env bash
# Verify the two bugs the VM found are actually fixed in the *published* 0.6.0
# binary, not a local build. Both live at the edges of the protocol, so this
# drives the daemon by writing LSP framing by hand and reads what comes back.
OUT="$HOME/poly-accept-060/lsp"
BIN="${1:-$HOME/.vscode/extensions/ricky.poly-lsp-0.6.0/bin/poly.exe}"
echo "binary: $BIN"
rm -rf "$OUT" && mkdir -p "$OUT/rsproj/src" && cd "$OUT" || exit 1

cat >rsproj/Cargo.toml <<'EOF'
[package]
name = "vmprobe"
version = "0.1.0"
edition = "2021"
EOF
cat >rsproj/src/main.rs <<'EOF'
fn greet(name: &str) -> String {
    format!("hello {name}")
}

fn main() {
    println!("{}", greet("vm"));
}

EOF

URI_DIR="file:///$(cygpath -m "$OUT/rsproj")"
URI_FILE="$URI_DIR/src/main.rs"
echo "root: $URI_DIR"

frame() {
	local body="$1" n
	n=$(printf '%s' "$body" | wc -c | tr -d ' ')
	printf 'Content-Length: %s\r\n\r\n%s' "$n" "$body"
}

# Slurp the whole file, then escape it for a JSON string. The loop label is `x`
# rather than the conventional `a` because the branch that goes with `a` spells
# an English word the typo linter rejects.
TEXT=$(sed ':x;N;$!bx;s/"/\\"/g;s/\n/\\n/g' rsproj/src/main.rs)

{
	frame "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"processId\":null,\"rootUri\":\"$URI_DIR\",\"capabilities\":{},\"initializationOptions\":{\"languageServers\":true,\"languageServerLogs\":true}}}"
	frame '{"jsonrpc":"2.0","method":"initialized","params":{}}'
	frame "{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didOpen\",\"params\":{\"textDocument\":{\"uri\":\"$URI_FILE\",\"languageId\":\"rust\",\"version\":1,\"text\":\"$TEXT\"}}}"
	# rust-analyzer answers empty while the crate graph is still building, so
	# give it room before asking anything with a real answer.
	sleep 50
	# On `greet` in the call on line 6 -- a definition that exists.
	frame "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"textDocument/definition\",\"params\":{\"textDocument\":{\"uri\":\"$URI_FILE\"},\"position\":{\"line\":5,\"character\":21}}}"
	# Hover on `greet`, to show hover routes downstream at all.
	frame "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"textDocument/hover\",\"params\":{\"textDocument\":{\"uri\":\"$URI_FILE\"},\"position\":{\"line\":5,\"character\":21}}}"
	# Hover on the blank last line. definition answers [] there, but hover has
	# no empty value to fall back on and returns null -- which is bug one: null
	# was dropped on the floor, leaving a reply with neither result nor error.
	frame "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"textDocument/hover\",\"params\":{\"textDocument\":{\"uri\":\"$URI_FILE\"},\"position\":{\"line\":7,\"character\":0}}}"
	sleep 20
	# No shutdown, no exit -- the pipe just closes, which is what an editor
	# that dies does. That is bug two.
} | "$BIN" lsp >stdout.bin 2>stderr.txt
echo "poly exit=$?"

echo "=== poly stderr"
cat stderr.txt

# One JSON object per line: drop the framing headers, then split where one
# object ends and the next begins.
tr -d '\r\n' <stdout.bin | sed 's/Content-Length: [0-9]*//g; s/}{"jsonrpc"/}\
{"jsonrpc"/g' >responses.txt
echo "=== responses ($(wc -l <responses.txt) lines)"
cut -c1-160 responses.txt

echo "=== checks"
fail=0

# fix 2 -- and first, proof the check is not vacuous: a server that never
# started cannot complain about how it was stopped.
if grep -q 'rust-analyzer' stderr.txt; then
	echo "PASS  rust-analyzer started (its stderr came through), so the next check can fail"
else
	echo "FAIL  no sign rust-analyzer ever started; the shutdown check below proves nothing"
	fail=1
fi
if grep -q 'without proper shutdown' stderr.txt; then
	echo "FAIL  fix2: rust-analyzer says poly walked out on it"
	fail=1
else
	echo "PASS  fix2: rust-analyzer did not complain about the shutdown"
fi

# fix 1
id3=$(grep '"id":3' responses.txt | head -1)
if [ -z "$id3" ]; then
	echo "FAIL  fix1: no reply to id 3 at all"
	fail=1
elif printf '%s' "$id3" | grep -q '"result"'; then
	if printf '%s' "$id3" | grep -q '"result":null'; then
		echo "PASS  fix1: id 3 carries \"result\":null -- the field the bug removed"
	else
		echo "SKIP  fix1: id 3 got a non-null result, so the null path was not exercised"
	fi
elif printf '%s' "$id3" | grep -q '"error"'; then
	echo "SKIP  fix1: id 3 got an error, so the null path was not exercised"
else
	echo "FAIL  fix1: reply to id 3 has neither result nor error: $id3"
	fail=1
fi

# The invariant, over every reply in the session. A message carrying both an
# id and a method is a request travelling the other way (registerCapability,
# diagnostic/refresh) and owes nobody a result.
bad=$(grep '"id":' responses.txt | grep -v '"method"' | grep -v '"result"' | grep -v '"error"')
if [ -n "$bad" ]; then
	echo "FAIL  invariant: replies with neither result nor error:"
	printf '%s\n' "$bad" | cut -c1-160
	fail=1
else
	echo "PASS  invariant: every reply carries a result or an error"
fi

echo "overall: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
