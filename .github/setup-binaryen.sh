#!/usr/bin/env bash
set -euo pipefail

BINARYEN_VERSION="version_132"
BINARYEN_SHA256="195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572"
archive="${RUNNER_TEMP}/binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz"
root="${RUNNER_TEMP}/binaryen-${BINARYEN_VERSION}"

curl --fail --location --retry 5 \
  --output "${archive}" \
  "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz"
echo "${BINARYEN_SHA256}  ${archive}" | sha256sum --check --strict
tar --extract --gzip --file "${archive}" --directory "${RUNNER_TEMP}"
echo "${root}/bin" >> "${GITHUB_PATH}"
"${root}/bin/wasm-opt" --version
