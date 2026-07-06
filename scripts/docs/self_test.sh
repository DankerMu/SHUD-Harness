#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CHECKER="$SCRIPT_DIR/check_links.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/shud-doc-link-test.XXXXXX")

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'docs link self-test failed: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$TMP_ROOT/docs/guide" "$TMP_ROOT/outside"
cat > "$TMP_ROOT/docs/index.md" <<'EOF'
# Top

[good](guide/page.md)
[good anchor](guide/page.md#second-heading)
[same-page anchor](#top)
[external ignored](https://example.invalid/missing.md)
[mailto ignored](mailto:pi@example.invalid)
[outside docs ignored](../outside/notes.md)

[reference-good]: guide/page.md#explicit-id
[reference-space-good]: <guide/page with space.md>

````markdown
```text
[ignored fenced inline](guide/fenced-inline-missing.md)
[ignored fenced reference]: <guide/fenced reference missing.md>
```
[ignored still fenced](guide/still-fenced-missing.md)
````
EOF

cat > "$TMP_ROOT/docs/guide/page.md" <<'EOF'
# Page

## Second Heading

### Explicit Heading {#explicit-id}
EOF

cat > "$TMP_ROOT/docs/guide/page with space.md" <<'EOF'
# Page With Space
EOF

cat > "$TMP_ROOT/docs/guide/fenced-anchors.md" <<'EOF'
# Fenced Anchors

````markdown
```text
## Inside Fence Heading
<a id="inside-fence-html"></a>
<div id="inside-fence-inline"></div>
```
````
EOF

cat > "$TMP_ROOT/outside/notes.md" <<'EOF'
# Outside Docs
EOF

"$CHECKER" --docs-root "$TMP_ROOT/docs" >/dev/null || fail "valid fixture returned non-zero"

cat >> "$TMP_ROOT/docs/index.md" <<'EOF'
[missing file](guide/missing.md)
[missing anchor](guide/page.md#not-there)
[missing space ref]: <guide/missing page.md>
[fenced heading anchor](guide/fenced-anchors.md#inside-fence-heading)
[fenced html anchor](guide/fenced-anchors.md#inside-fence-html)
[fenced inline id](guide/fenced-anchors.md#inside-fence-inline)
EOF

output=$("$CHECKER" --docs-root "$TMP_ROOT/docs" 2>&1) && fail "broken fixture returned zero"
printf '%s\n' "$output" | grep -q "guide/missing.md" || fail "missing file was not reported"
printf '%s\n' "$output" | grep -q "not-there" || fail "missing anchor was not reported"
printf '%s\n' "$output" | grep -q "missing page.md" || fail "missing reference target with spaces was not reported"
printf '%s\n' "$output" | grep -q "inside-fence-heading" || fail "fenced heading anchor was incorrectly collected"
printf '%s\n' "$output" | grep -q "inside-fence-html" || fail "fenced html anchor was incorrectly collected"
printf '%s\n' "$output" | grep -q "inside-fence-inline" || fail "fenced inline id was incorrectly collected"
reported_count=$(printf '%s\n' "$output" | grep -c '^- ')
if [ "$reported_count" -ne 6 ]; then
  printf '%s\n' "$output" >&2
  fail "expected exactly six broken-link report lines, got $reported_count"
fi

printf '%s\n' "docs link self-test passed"
