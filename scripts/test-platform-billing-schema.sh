#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-platform_control_test}"
DB_USER="${DB_USER:-root}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
if [[ ! "$DB_NAME" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then echo "Unsafe test database name" >&2; exit 2; fi

mysql_cmd=(mysql --protocol=tcp --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --batch --skip-column-names)
export MYSQL_PWD="$DB_PASSWORD"

"${mysql_cmd[@]}" -e "CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/001_platform_tenant_registry.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/002_platform_billing.sql"

expected_tables=11
actual_tables="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_type = 'BASE TABLE' AND table_name IN ('platform_billing_accounts','platform_products','platform_plans','platform_subscriptions','platform_invoices','platform_invoice_lines','platform_payment_transactions','platform_payment_webhook_events','platform_refunds','platform_ledger_entries','platform_billing_audit')")"
if [[ "$actual_tables" != "$expected_tables" ]]; then
  echo "Expected $expected_tables platform billing tables, found $actual_tables" >&2
  exit 1
fi

fk_count="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = '$DB_NAME'")"
if (( fk_count < 10 )); then
  echo "Expected at least 10 platform billing foreign keys, found $fk_count" >&2
  exit 1
fi

check_count="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = '$DB_NAME' AND constraint_type = 'CHECK' AND table_name = 'platform_invoices'")"
if (( check_count < 1 )); then
  echo "Invoice total CHECK constraint was not installed" >&2
  exit 1
fi

echo "Platform registry + billing MariaDB migration passed: $actual_tables billing tables, $fk_count foreign keys."
