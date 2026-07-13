#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
TARBALL="$(npm pack --silent)"
TARBALL_PATH="$ROOT/$TARBALL"
trap 'rm -rf "$WORK"; rm -f "$TARBALL_PATH"' EXIT

mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
npm init -y >/dev/null
npm install --silent "$TARBALL_PATH"

git init -q
git config user.email "ci@voidarch.local"
git config user.name "Voidarch CI"
mkdir -p src docs
cat > src/auth.ts <<'EOF'
export function refreshAccessToken(refreshToken: string): string {
  if (!refreshToken) throw new Error("refresh token required");
  return `access:${refreshToken}`;
}
EOF
cat > src/index.ts <<'EOF'
export { refreshAccessToken } from "./auth.js";
EOF
cat > docs/auth.md <<'EOF'
# Authentication

Access tokens are renewed with a rotating refresh token. Never log token values.
EOF
cat > package.json <<'EOF'
{
  "name": "voidarch-context-smoke-consumer",
  "private": true,
  "type": "module"
}
EOF
git add .
git commit -qm "seed smoke repository"

BIN="$WORK/consumer/node_modules/.bin/voidarch-context"

"$BIN" help | grep -q "local repo memory"
"$BIN" init

test -f .voidarch/config.json
grep -q '"repoId"' .voidarch/config.json
grep -q '.voidarch/db/' .gitignore

"$BIN" ingest > "$WORK/ingest.txt"
"$BIN" graph build > "$WORK/graph.txt"
"$BIN" remember --kind decision "Use rotating refresh tokens" > "$WORK/remember.txt"
"$BIN" search "refresh token" > "$WORK/search.txt"
"$BIN" query "refreshAccessToken" > "$WORK/query.txt"
"$BIN" context "fix auth token refresh" --format json --max-tokens 2000 > "$WORK/context.json"
"$BIN" status > "$WORK/status.txt"

node - <<'NODE' "$WORK/context.json"
const fs = require('node:fs');
const path = process.argv[2];
const pack = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!pack || typeof pack !== 'object') throw new Error('context output is not an object');
if (!pack.task || !String(pack.task.goal || '').includes('auth token refresh')) {
  throw new Error('context pack does not preserve the requested task');
}
if (!pack.token_budget || typeof pack.token_budget.estimated_tokens !== 'number') {
  throw new Error('context pack is missing token budget metadata');
}
NODE

grep -qi "refresh" "$WORK/search.txt"
grep -qi "refreshAccessToken\|auth.ts" "$WORK/query.txt"
grep -qi "decision\|rotating refresh" "$WORK/remember.txt"
grep -qi "repo\|document\|graph\|memory" "$WORK/status.txt"

echo "Voidarch Context packed CLI smoke test passed."
