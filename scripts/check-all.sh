#!/usr/bin/env bash
# Local checks to run before committing. Nothing is sent to the network.
# Usage: ./check-all.sh
#        ./check-all.sh --with-tests    (also runs cargo test when a Cargo.toml is found)
set -uo pipefail; cd "$(dirname "$0")"; source ./env.sh

fail=0
step() { echo "== $1"; }

step "shell syntax"
for f in *.sh; do
  if bash -n "$f"; then echo "PASS  $f"; else echo "FAIL  $f"; fail=1; fi
done

step "validate-manifest.js syntax"
if node --check validate-manifest.js; then echo "PASS  validate-manifest.js"; else echo "FAIL  validate-manifest.js"; fail=1; fi

step "manifest"
if [ -f "$MANIFEST" ]; then
  node ./validate-manifest.js "$MANIFEST" || fail=1
else
  echo "SKIP  manifest not found at $MANIFEST"
fi

if [ "${1:-}" = "--with-tests" ]; then
  step "contract tests"
  cargo_file=$(find .. -maxdepth 3 -name Cargo.toml -not -path '*/target/*' | head -n1)
  if [ -n "$cargo_file" ] && command -v cargo >/dev/null 2>&1; then
    (cd "$(dirname "$cargo_file")" && cargo test) || fail=1
  else
    echo "SKIP  no Cargo.toml or cargo not available"
  fi
fi

[ "$fail" -eq 0 ] && echo "Result: OK" || { echo "Result: FAILED"; exit 1; }
