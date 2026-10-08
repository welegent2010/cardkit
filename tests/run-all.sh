#!/bin/sh
# One entry point for every dev check in this project.
# Usage: tests/run-all.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p output

NODE_BIN="${NODE_BIN:-$(ls -d ~/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | tail -1)}"
[ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
export NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules

echo "== CardKit smoke test =="
"$NODE_BIN" tests/smoke.js
