# Legacy schema to tenant-database migration inventory

This inventory is derived from db/schema.sql on the refactor branch. It is a migration contract, not an executable data migration.

## Current physical databases

| Current database | Tables | Current isolation |
|---|---:|---|
| house_sys | 10 | Shared platform and tenant identities/settings/session rows using org_id |
| house_sys_rental | 10 | Shared across rental orgs; all 10 tables contain org_id |
| house_sys_hotel | 6 | Shared across hotel orgs; all 6 tables contain org_id |
| house_sys_property | 10 | Shared across property orgs; all 10 tables contain org_id |

## Product table ownership

- Rental: buildings, rooms, tenants, contracts, meters, room_net_lines, net_changes, net_requests, bills, repairs.
- Hotel: buildings, rooms, tenants, orders, bills, repairs.
- Property: buildings, rooms, tenants, org_employees, meters, room_net_lines, net_changes, bills, repairs, complaints.

Every product table above currently has org_id. A destination tenant database must contain rows from exactly one legacy org. Remove org_id only after SQL, indexes, unique constraints and all references have been rewritten for the single-tenant model.

## Shared identity database split

| Legacy table | Destination |
|---|---|
| orgs | Platform tenant registry metadata; map each legacy org to opaque tenant UUID |
| users | Tenant-local users; verified super-admin accounts separately extracted to platform identity |
| roles, role_permissions, user_permissions | Tenant-local role and permission tables |
| settings | Tenant-local settings |
| sessions | Revoke all active tokens; require fresh login |
| usage_fee_config, usage_fee_payments | Platform subscription configuration/payment metadata only |
| app_config | Split platform-wide controls from tenant-facing product preferences |

## Migration blockers

1. Inventory every foreign key, unique key, index, SQL join, org_id predicate and numeric ID reference.
2. Inspect login, role resolution, company-admin, billing, upload, export, report and background-job routes; current code reads shared house_sys identity/config tables.
3. Remove global super-admin bypasses from business APIs; platform identity must authenticate only to platform API.
4. Build versioned product-specific tenant schemas. The current monolithic db/schema.sql drops and recreates shared databases and is not a tenant provisioning migration.
5. Build a read-only dry-run extractor reporting row counts, monetary sums, orphan references, duplicate business keys and file checksums per org.
6. Run isolated restore drills and negative cross-tenant end-to-end tests before production cutover.

## Safety

- Never execute current destructive db/schema.sql against production as part of tenant migration.
- No production data has been copied or changed by this PR.
- Never activate a tenant before its DB principal, migrations, secret reference and isolation verifier succeed.
- Keep PR draft until product APIs, all four production frontends, tenant schema migrations, legacy data migration and cross-tenant E2E tests are complete.


## Tenant-local bill transaction ledger

Migration `db/migrations/tenant/003_bill_transactions.sql` adds an append-only `bill_transactions` table to each product tenant database. Receipt and refund rows are written in the same transaction as the bill balance update. Request IDs are unique within the tenant database. Refunds are capped at the current paid balance and are blocked when the historical ledger net does not reconcile with the bill's stored paid_amount; legacy balances must be reconciled before refunding. The `/bill-transactions` read projection is tenant-local. Existing tenant databases must apply this additive migration before enabling the new payment/refund routes.
