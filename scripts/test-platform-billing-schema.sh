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
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/003_product_sessions.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/004_tenant_login_hosts.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/005_login_attempt_rate_limit.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/007_platform_admin_mfa.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/008_platform_admin_auth.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/009_platform_admin_login_rate_limit.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/010_platform_admin_step_up_mfa.sql"
"${mysql_cmd[@]}" "$DB_NAME" < "$ROOT_DIR/db/migrations/platform/011_platform_admin_audit.sql"

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

session_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'platform_product_sessions' AND table_type = 'BASE TABLE'")"
if [[ "$session_table" != "1" ]]; then echo "Product session migration was not installed" >&2; exit 1; fi
if (( fk_count < 11 )); then echo "Expected product session and billing foreign keys, found $fk_count" >&2; exit 1; fi

test_tenant_uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
login_host_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'platform_tenant_login_hosts' AND table_type = 'BASE TABLE'")"
if [[ "$login_host_table" != "1" ]]; then echo "Tenant login host migration was not installed" >&2; exit 1; fi
login_attempt_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'platform_login_attempts' AND table_type = 'BASE TABLE'")"
if [[ "$login_attempt_table" != "1" ]]; then echo "Login attempt rate-limit migration was not installed" >&2; exit 1; fi
login_hash_column="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = '$DB_NAME' AND table_name = 'platform_login_attempts' AND column_name = 'identity_hash' AND character_maximum_length = 64")"
if [[ "$login_hash_column" != "1" ]]; then echo "Privacy-preserving login identity hash column was not installed" >&2; exit 1; fi

test_session_id='ci-product-session-revocation-0001'
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO platform_tenants (tenant_uuid, app_id, display_label, lifecycle_state, db_host, db_port, db_name, db_secret_ref) VALUES ('$test_tenant_uuid', 'rental', 'CI tenant', 'active', '127.0.0.1', 3306, 'ci_tenant_db', 'ci/tenant/db')"
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO platform_tenant_login_hosts (hostname, app_id, tenant_uuid, status) VALUES ('ci-login.example.test', 'rental', '$test_tenant_uuid', 'active')"
mapped_login_host=$("${mysql_cmd[@]}" "$DB_NAME" -e 'SELECT COUNT(*) FROM platform_tenant_login_hosts WHERE hostname = "ci-login.example.test" AND app_id = "rental" AND tenant_uuid = "'$test_tenant_uuid'" AND status = "active"')
wrong_login_audience=$("${mysql_cmd[@]}" "$DB_NAME" -e 'SELECT COUNT(*) FROM platform_tenant_login_hosts WHERE hostname = "ci-login.example.test" AND app_id = "hotel" AND status = "active"')
if [[ "$mapped_login_host" != "1" || "$wrong_login_audience" != "0" ]]; then
  echo "Exact tenant login host/product mapping verification failed" >&2
  exit 1
fi
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO platform_product_sessions (session_id, app_id, tenant_uuid, subject_id, issued_at, expires_at) VALUES ('$test_session_id', 'rental', '$test_tenant_uuid', 'ci-user-1', UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))"
active_session="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM platform_product_sessions WHERE session_id = '$test_session_id' AND subject_id = 'ci-user-1' AND tenant_uuid = '$test_tenant_uuid' AND app_id = 'rental' AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()")"
wrong_audience="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM platform_product_sessions WHERE session_id = '$test_session_id' AND app_id = 'hotel' AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()")"
if [[ "$active_session" != "1" || "$wrong_audience" != "0" ]]; then
  echo "Product session binding/expiry verification failed" >&2
  exit 1
fi
"${mysql_cmd[@]}" "$DB_NAME" -e "UPDATE platform_product_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = '$test_session_id'"
revoked_session="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM platform_product_sessions WHERE session_id = '$test_session_id' AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()")"
if [[ "$revoked_session" != "0" ]]; then
  echo "Revoked product session remained active" >&2
  exit 1
fi
echo "Platform registry + billing + product session MariaDB migrations passed: $actual_tables billing tables, $fk_count foreign keys."

echo "Platform login attempt rate-limit schema verified."

mfa_tables="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_type = 'BASE TABLE' AND table_name IN ('platform_admin_mfa_enrollments','platform_admin_mfa_factors','platform_admin_mfa_recovery_codes')")"
if [[ "$mfa_tables" != "3" ]]; then
  echo "Expected 3 platform administrator MFA tables, found $mfa_tables" >&2
  exit 1
fi
echo "Platform administrator MFA storage schema verified: $mfa_tables tables."

admin_auth_tables="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_type = 'BASE TABLE' AND table_name IN ('platform_admin_login_challenges','platform_admin_sessions')")"
if [[ "$admin_auth_tables" != "2" ]]; then
  echo "Expected 2 platform admin auth tables, found $admin_auth_tables" >&2
  exit 1
fi
admin_permissions_column="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = '$DB_NAME' AND table_name = 'platform_admins' AND column_name = 'permissions_json'")"
if [[ "$admin_permissions_column" != "1" ]]; then
  echo "Platform admin permissions column was not installed" >&2
  exit 1
fi
echo "Platform administrator authentication schema verified: $admin_auth_tables tables."

platform_login_app_enum="$("${mysql_cmd[@]}" -e "SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema = '$DB_NAME' AND table_name = 'platform_login_attempts' AND column_name = 'app_id'")"
if [[ "$platform_login_app_enum" != *"platform"* ]]; then
  echo "Platform administrator rate-limit namespace was not installed" >&2
  exit 1
fi


step_up_column="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = '$DB_NAME' AND table_name = 'platform_admin_sessions' AND column_name = 'last_step_up_at' AND is_nullable = 'YES'")"
if [[ "$step_up_column" != "1" ]]; then
  echo "Separate platform administrator step-up MFA timestamp was not installed" >&2
  exit 1
fi
echo "Platform administrator step-up MFA schema verified."

audit_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'platform_admin_audit_events' AND table_type = 'BASE TABLE'")"
if [[ "$audit_table" != "1" ]]; then echo "Platform admin audit migration was not installed" >&2; exit 1; fi
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO platform_admin_audit_events (admin_id, action, outcome, detail_code) VALUES (NULL, 'admin.login', 'success', 'CI_SCHEMA_CHECK')"
audit_row="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM platform_admin_audit_events WHERE action = 'admin.login' AND detail_code = 'CI_SCHEMA_CHECK'")"
if [[ "$audit_row" != "1" ]]; then echo "Platform admin audit insert/readback failed" >&2; exit 1; fi
echo "Platform administrator audit schema and write/readback verified."
