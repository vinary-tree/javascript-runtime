#!/usr/bin/env bash
set -euo pipefail

node scripts/sync-release-version.mjs
node scripts/check-release-ref.mjs --self-test
node scripts/release-source-refs.mjs --self-test
node scripts/checkout-family-sources.mjs --self-test
node --test test/local-layout.test.mjs
node scripts/stage-license.mjs
node scripts/check-docs.mjs

while IFS= read -r source; do
  node --check "$source"
done < <(find . -type f -name '*.mjs' \
  -not -path './.build/*' \
  -not -path './generated/*' \
  -not -path './node_modules/*' \
  -not -path './test-property/node_modules/*' | sort)

cargo fmt --manifest-path rust/Cargo.toml --all -- --check

if [[ "${1:-}" == "--built" ]]; then
  cargo test --manifest-path rust/Cargo.toml --all-targets
  npm run test:native
  npm run test:leak
  npm run test:property
  npm test
  npm run verify:package
fi
