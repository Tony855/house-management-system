#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${NODE_ENV:-}" != "test" ]]; then
  echo "Refusing to run tenant system schema test unless NODE_ENV=test" >&2
  exit 2
fi
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_NAME="${TENANT_SYSTEM_TEST_DB:-tenant_system_schema_test}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
if [[ ! "$DB_NAME" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then echo "Unsafe test database name" >&2; exit 2; fi

mysql_cmd=(mysql --protocol=tcp --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --batch --skip-column-names)
export MYSQL_PWD="$DB_PASSWORD"
"${mysql_cmd[@]}" -e "CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/002_tenant_write_idempotency.sql
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/003_tenant_write_audit.sql

idempotency_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'tenant_write_idempotency' AND table_type = 'BASE TABLE'")"
audit_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'tenant_write_audit_events' AND table_type = 'BASE TABLE'")"
if [[ "$idempotency_table" != "1" || "$audit_table" != "1" ]]; then
  echo "Tenant write system migrations are incomplete" >&2
  exit 1
fi
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO tenant_write_audit_events (app_id, tenant_uuid, user_id, session_id, operation, reason, request_id, event_type) VALUES ('rental', '12345678-1234-4123-8123-123456789abc', 'ci-user', 'ci-session-1234567890', 'create', 'CI migration smoke test', 'ci-request-1234567890', 'tenant_write_started')"
audit_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM tenant_write_audit_events WHERE request_id = 'ci-request-1234567890' AND event_type = 'tenant_write_started'")"
if [[ "$audit_rows" != "1" ]]; then echo "Tenant write audit insert/readback failed" >&2; exit 1; fi
echo "Tenant write idempotency and audit migrations passed."
