#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bash -n deploy.sh
node --check server/seed.js
bash deploy.sh --help >/dev/null
if grep -Eq '^[[:space:]]*--force\\)' deploy.sh; then
  echo "Unsafe --force option found in installer" >&2
  exit 1
fi
grep -Fq 'Refusing destructive db/schema.sql import' deploy.sh
grep -Fq 'GRANT SELECT, INSERT, UPDATE, DELETE ON house_sys.*' deploy.sh
grep -Fq 'User=house-sys' deploy.sh
grep -Fq 'ProtectSystem=strict' deploy.sh
grep -Fq 'chmod 0600 "$CREDENTIAL_FILE"' deploy.sh
grep -Fq 'HOUSE_SYS_SUPERADMIN_PASSWORD' deploy.sh
echo "Installer static safety checks passed."
