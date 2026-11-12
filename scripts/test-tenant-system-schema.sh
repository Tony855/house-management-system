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
# Property-only collection schema smoke test, including the bill foreign key.
"${mysql_cmd[@]}" "$DB_NAME" -e "CREATE TABLE IF NOT EXISTS bills (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB"
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/005_property_collection_actions.sql
collection_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'property_collection_actions' AND table_type = 'BASE TABLE'")"
if [[ "$collection_table" != "1" ]]; then echo "Property collection migration is incomplete" >&2; exit 1; fi
"${mysql_cmd[@]}" "$DB_NAME" -e "DELETE FROM property_collection_actions WHERE request_id = 'ci-collection-1234567890'; DELETE FROM bills WHERE id = 1; INSERT INTO bills (id) VALUES (1); INSERT INTO property_collection_actions (bill_id, action_type, outcome, contacted_at, follow_up_date, note, request_id) VALUES (1, 'phone', 'promised', '2030-01-01', '2030-01-08', 'CI collection smoke test', 'ci-collection-1234567890')"
collection_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM property_collection_actions WHERE bill_id = 1 AND outcome = 'promised' AND follow_up_date = '2030-01-08'")"
if [[ "$collection_rows" != "1" ]]; then echo "Property collection migration insert/readback failed" >&2; exit 1; fi
if [[ "$idempotency_table" != "1" || "$audit_table" != "1" ]]; then
  echo "Tenant write system migrations are incomplete" >&2
  exit 1
fi
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO tenant_write_audit_events (app_id, tenant_uuid, user_id, session_id, operation, reason, request_id, event_type) VALUES ('rental', '12345678-1234-4123-8123-123456789abc', 'ci-user', 'ci-session-1234567890', 'create', 'CI migration smoke test', 'ci-request-1234567890', 'tenant_write_started')"
audit_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM tenant_write_audit_events WHERE request_id = 'ci-request-1234567890' AND event_type = 'tenant_write_started'")"
if [[ "$audit_rows" != "1" ]]; then echo "Tenant write audit insert/readback failed" >&2; exit 1; fi
# Rental contract deposit ledger schema smoke test.
"${mysql_cmd[@]}" "$DB_NAME" -e "CREATE TABLE IF NOT EXISTS contracts (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB"
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/007_rental_contract_deposit_transactions.sql
deposit_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'rental_contract_deposit_transactions' AND table_type = 'BASE TABLE'")"
if [[ "$deposit_table" != "1" ]]; then echo "Rental deposit migration is incomplete" >&2; exit 1; fi
"${mysql_cmd[@]}" "$DB_NAME" -e "DELETE FROM rental_contract_deposit_transactions WHERE request_id = 'ci-rental-deposit-smoke-0001'; DELETE FROM contracts WHERE id = 1; INSERT INTO contracts (id) VALUES (1); INSERT INTO rental_contract_deposit_transactions (contract_id, transaction_type, amount, pay_method, request_id, transaction_date) VALUES (1, 'receipt', 25.00, 'cash', 'ci-rental-deposit-smoke-0001', '2030-01-01')"
deposit_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM rental_contract_deposit_transactions WHERE contract_id = 1 AND transaction_type = 'receipt' AND amount = 25.00")"
if [[ "$deposit_rows" != "1" ]]; then echo "Rental deposit migration insert/readback failed" >&2; exit 1; fi
# Durable property fee generation queue smoke test.
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/008_property_fee_generation_jobs.sql
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/009_rental_bill_generation_jobs.sql
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/010_tenant_billing_job_leases.sql
"${mysql_cmd[@]}" "$DB_NAME" < db/migrations/tenant/011_tenant_billing_job_retries.sql
fee_job_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'property_fee_generation_jobs' AND table_type = 'BASE TABLE'")"
if [[ "$fee_job_table" != "1" ]]; then echo "Property fee job migration is incomplete" >&2; exit 1; fi
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO property_fee_generation_jobs (billing_month,request_id,state) VALUES ('2030-01','ci-property-fee-job-0001','queued')"
fee_job_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM property_fee_generation_jobs WHERE billing_month = '2030-01' AND state = 'queued'")"
if [[ "$fee_job_rows" != "1" ]]; then echo "Property fee job migration insert/readback failed" >&2; exit 1; fi
rental_job_table="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'rental_bill_generation_jobs' AND table_type = 'BASE TABLE'")"
if [[ "$rental_job_table" != "1" ]]; then echo "Rental bill job migration is incomplete" >&2; exit 1; fi
"${mysql_cmd[@]}" "$DB_NAME" -e "INSERT INTO rental_bill_generation_jobs (as_of_date,request_id,state) VALUES ('2030-02-01','ci-rental-bill-job-0001','queued')"
rental_job_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM rental_bill_generation_jobs WHERE as_of_date = '2030-02-01' AND state = 'queued'")"
if [[ "$rental_job_rows" != "1" ]]; then echo "Rental bill job migration insert/readback failed" >&2; exit 1; fi

# Verify both tenant job tables carry the lease columns and accept a live lease.
lease_columns="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = '$DB_NAME' AND table_name IN ('property_fee_generation_jobs','rental_bill_generation_jobs') AND column_name IN ('lease_owner','lease_token','lease_expires_at','attempt_count')")"
if [[ "$lease_columns" != "8" ]]; then echo "Tenant billing job lease migration is incomplete" >&2; exit 1; fi
"${mysql_cmd[@]}" "$DB_NAME" -e "UPDATE property_fee_generation_jobs SET state='running', lease_owner='ci-worker', lease_token='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lease_expires_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 SECOND), attempt_count=attempt_count+1 WHERE billing_month='2030-01' AND state='queued'"
lease_rows="$("${mysql_cmd[@]}" "$DB_NAME" -e "SELECT COUNT(*) FROM property_fee_generation_jobs WHERE billing_month='2030-01' AND lease_owner='ci-worker' AND lease_token='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND lease_expires_at>UTC_TIMESTAMP() AND attempt_count=1")"
if [[ "$lease_rows" != "1" ]]; then echo "Tenant billing job lease write/readback failed" >&2; exit 1; fi
retry_columns="$("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = '$DB_NAME' AND ((table_name = 'property_fee_generation_jobs' AND column_name = 'next_attempt_at') OR (table_name = 'rental_bill_generation_jobs' AND column_name IN ('next_attempt_at','last_error')))")"
if [[ "$retry_columns" != "3" ]]; then echo "Tenant billing retry migration is incomplete" >&2; exit 1; fi
echo "Tenant system, collection, deposit, property and rental bill job migrations and lease migrations passed."
