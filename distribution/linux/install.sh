#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=${AGENT_ACP_NODE:-node}
if ! command -v "$NODE" >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22.12+ is required (24 LTS recommended). Install Node for Linux first, or set AGENT_ACP_NODE to its absolute executable path.' >&2
  exit 1
fi
exec "$NODE" "$BASE/updater.mjs" install "$@"
