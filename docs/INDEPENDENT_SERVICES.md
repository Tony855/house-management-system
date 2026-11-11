# Independent application and service boundaries

## Application entrypoints

- Rental: `apps/rental-web/index.html` + `portal.js`, audience `rental`, cookie contract `rental_session`.
- Hotel: `apps/hotel-web/index.html` + `portal.js`, audience `hotel`, cookie contract `hotel_session`.
- Property: `apps/property-web/index.html` + `portal.js`, audience `property`, cookie contract `property_session`.
- Super Admin: `apps/super-admin-web/index.html` + `portal.js`, audience `platform`, cookie contract `platform_session`.

The entrypoints are separate static applications and do not import the legacy shared browser bundle or read/write localStorage/sessionStorage. Each app ships its own `portal.css` so it can be deployed from its directory without a cross-app asset dependency. `apps/portal.css` is the shared design source only; it does not share application state or credentials.

The current portal pages are architecture/UI shells. Business screens, real login/session refresh, permission-aware navigation, production API URLs, CSP and per-origin cookie issuance are not yet wired. The health probe is not authentication and must never be treated as proof of a user session.

## Product API composition

- `server/product-api.js` builds a product API only when a verified authenticator, platform tenant registry, secret provider and tenant pool manager are injected.
- `services/rental-api/app.js`, `services/hotel-api/app.js`, and `services/property-api/app.js` pin the service audience in code.
- Authentication must validate JWT/session signature, issuer, expiry, audience and app ID before setting `req.auth`.
- `server/product-dependencies.js` composes the verifier, platform registry, session store, secret manager adapter and tenant pool manager into one fail-closed dependency bundle for each product API.
- `server/platform-adapters.js` now provides the production-shaped platform tenant registry reader, revocation-aware product session lookup (using database UTC time), and a secret-manager adapter. The adapter keeps DB credentials outside the registry and fails closed on malformed secret payloads.
- Migration `003_product_sessions.sql` adds platform-side session revocation records bound to app, tenant and opaque subject IDs; tenant user profiles and credentials remain outside the platform database.
- `server/product-auth.js` now provides a fail-closed HS256 access-token verifier. It requires a key-rotation adapter (`getVerificationKey({ kid, appId })`) and a revocation-aware session adapter (`isSessionActive({ sessionId, userId, tenantId, appId })`); missing keys, unavailable session storage and revoked sessions fail closed.
- Product access tokens require `iss`, `aud`, fixed `appId`, `sub`, UUID `tenantId`, `jti`, `iat` and `exp`; token lifetime is capped at 15 minutes by default. Only verified claims are copied to `req.auth`. The helper does not issue tokens, manage passwords/MFA, or replace a production key manager/session database.
- Product API error responses now restrict status codes to 400–599 and do not return arbitrary exception messages or secret-bearing middleware errors to clients.
- `server/tenant-repository.js` exposes allowlisted per-product tables through the resolved `req.tenantDb` pool only. Product requests receive `req.tenantRepository`; it supports parameterized list/find/count/insert/update/delete and connection-scoped transactions. It has no platform-pool or legacy-pool fallback.
- Repository table and column allowlists are pinned to reviewed product projections. Wildcard selection is disabled; tenant identity documents, employee ID/passport fields, card numbers, photos and license identifiers are omitted from the public read projection. SQL values are always bound parameters; identifiers, sort direction and pagination are validated before query construction.
- Rental, Hotel and Property now mount separate read-only resource routes (`/api/buildings`, `/api/rooms`, `/api/tenants`, plus product-specific resources). These routes use only the resolved tenant repository, return bounded pages and counts, and reject unreviewed sort columns. Mutating business workflows remain intentionally unavailable until tenant scope, authorization, audit and legacy `org_id` migration are implemented.
- Tenant ID is read only from that verified context. Request headers, query strings and bodies are ignored for tenant selection.
- `createTenantMiddleware` resolves active tenant registry state and retrieves credentials through the secret provider before opening a tenant pool.
- `/api/tenant-context` exposes only opaque tenant ID, app ID and schema version; it never returns DB host, DB name or credentials.

These factories are deployable boundaries, not yet the production authentication integration or migrated business API. The legacy `server/app.js` continues to serve the existing API until each product's routes and data are migrated and verified.

## Platform control plane

- `server/platform-db.js` creates a dedicated pool from `PLATFORM_DB_*` variables only. It deliberately refuses fallback to legacy DB variables.
- `services/platform-api/app.js` mounts the Platform Billing API on an injected platform DB pool.
- `services/platform-api/repository.js` reads only platform registry and billing tables. Tenant list responses omit DB host, DB name and secret reference.
- `services/platform-api/routes.js` requires injected authentication plus platform audience, active admin, MFA and scoped permissions. Plan writes additionally require step-up and a reason, and are written with an audit row in one transaction.

Required deployment variables (use a secret manager; never commit values):

```text
PLATFORM_DB_HOST
PLATFORM_DB_PORT
PLATFORM_DB_NAME
PLATFORM_DB_USER
PLATFORM_DB_PASSWORD
PLATFORM_DB_POOL_SIZE
```

The Platform API currently exposes read endpoints for overview, products, plans, tenants, invoices and revenue ledger, plus draft plan creation. A generic payment-provider adapter contract and raw-body HMAC-SHA256 verifier are implemented and unit-tested, but no provider-specific adapter or webhook HTTP endpoint is enabled. Subscription lifecycle commands, invoice issuance/collection scheduler, refund execution and reconciliation remain unimplemented. Do not enable public billing writes or production collection until those controls exist.

## Isolation and rollout

1. Deploy the control-plane database separately from all tenant databases.
2. Wire an audited platform authenticator and secret manager.
3. Provision one product tenant at a time with unique DB principal and least-privilege grants.
4. Migrate that product's schema and data, compare row counts/checksums, and run cross-tenant denial tests.
5. Deploy product API routes only after their repository layer is tenant-pool-only.
6. Keep legacy APIs read-only during controlled cutover, then retire only after rollback window and backup restore drill.


## Provisioning safety contract

- `provisionTenant` requires an explicit durable audit adapter before any provisioning side effect; it does not silently substitute a no-op audit callback.
- The `provisioning_verified` audit event is persisted after schema/isolation verification and before registry activation. If that audit write fails, activation is blocked and the deterministic resources are cleaned up.
- Database, principal and secret creation attempts are recorded before awaiting the remote adapter. If a remote create succeeds but the client times out, cleanup still attempts deletion using the tenant UUID-derived resource names. Cleanup adapters must make delete/drop operations idempotent and treat an already-absent resource as success.
- A failed failure-audit write is attached to the original provisioning error as `auditFailure` and included in `cleanupFailures`; it is never silently discarded. Production audit storage must be durable and alert on write failure.

No production DB migration or data deletion is performed by the CI jobs.


## Tenant data copy gate (non-destructive)

`server/tenant-data-migration.js` defines the next migration boundary for moving a legacy `org_id` into a database-per-tenant product database:

- Dry-run is the default. It exports the complete reviewed product-table set for one positive integer `sourceOrgId`, verifies every source row belongs to that org, strips the legacy `org_id` column, and produces per-table row counts and canonical SHA-256 digests.
- Copy mode requires a complete target writer, target reader and durable audit adapter. The target writer must import the complete snapshot in one transaction; the target reader must read back all tables for count/digest reconciliation.
- A mismatch fails closed and is audited. The migration result never performs cutover; legacy source data and routing are not modified or deleted.
- This is an orchestration contract with adapter interfaces, not a production migration runner. No live source/target adapters, tenant-specific database cutover, rollback window or production rehearsal are claimed complete. The next step is to implement and test the actual read-only legacy export and transactional tenant import adapters against disposable MariaDB fixtures.


### MariaDB migration adapters

- `server/tenant-data-migration-mariadb.js` provides mysql2-compatible source reader, tenant target writer and target read-back adapters.
- Every legacy source query is restricted by a bound `org_id = ?` predicate and uses the fixed product table allowlist. Configure the source connection with a read-only principal limited to the legacy product database.
- The tenant writer acquires a MariaDB advisory lock for the tenant, refuses any non-empty target table, inserts all reviewed rows in one transaction, and rolls back on any error. The lock is released before the connection is returned.
- The target reader reads back the full tenant table set for count and SHA-256 reconciliation. The target schema must be pre-migrated without `org_id`; the writer rejects attempts to insert that legacy column.
- Adapter contract tests cover source scoping, transaction commit/rollback, non-empty target refusal, lock lifecycle and org_id injection. These are adapter tests using mysql2-compatible fakes; a live legacy-to-tenant production migration, backup restore and cutover remain separate acceptance gates.


The CI legacy MariaDB integration now creates an ephemeral tenant database, clones the Rental product schema without `org_id`, inserts a uniquely scoped fixture into the disposable legacy schema, executes the real mysql2 adapters, and verifies target read-back plus SHA-256 reconciliation. The fixture row and ephemeral database are removed in a `finally` cleanup. This validates the concrete Rental path against MariaDB; it is not a production tenant cutover or a full data migration for Hotel/Property.


### Expanded tenant migration acceptance checks

- The MariaDB integration job now exercises Rental, Hotel and Property product table sets, rather than Rental alone.
- For each product it creates two isolated tenant databases, clones the product schema without legacy `org_id`, copies one org-scoped fixture while excluding a second org's decoy row, and verifies that the same primary key can exist independently in both tenant DB namespaces.
- The test mutates the second tenant's copy and confirms the first tenant's copy is unchanged. It also checks copy manifests and target read-back. Temporary fixture rows and target databases are cleaned in `finally`.
- Adapter contract tests cover lock contention and destroy a pooled connection when advisory lock release cannot be confirmed, avoiding returning a connection with a potentially-held lock to the pool.
- These checks validate the tested migration path and database namespace boundary; they do not yet prove the entire application authorization layer or all production relationships are tenant-safe.


### Tenant write boundary

- Product APIs may receive an optional `writeService`; when configured, authenticated requests get a `req.tenantWrite` capability bound to the verified `req.auth`, resolved tenant context and tenant repository.
- The write service requires product/tenant context agreement, explicit domain authorization, step-up verification, a reason, a request identifier and a transaction-aware audit adapter.
- Both start and committed audit records are appended using the same tenant transaction handle as the domain mutation. Audit failure or domain failure rolls the transaction back.
- This is a guarded write boundary, not a blanket activation of generic CRUD endpoints. Product-specific write routes must still implement domain validation and call this capability explicitly; current read routes remain read-only.


- Migration preflight validates known in-product references (for example room-to-building, contract-to-room/tenant, bill-to-contract/order, and maintenance-to-room) against the selected tenant snapshot before any target write. Historical orphan references fail closed and require explicit data repair; this preflight does not invent or silently rewrite missing relationships.
- MariaDB migration adapters verify `SELECT DATABASE()` on the source and tenant target connections. Source must be `house_sys_<product>`; target must exactly match the canonical tenant DB name generated from the product and tenant UUID.


### Tenant write idempotency gate

- The tenant write service now requires an explicit idempotency adapter in addition to authorization, step-up and transactional audit.
- Every write carries a SHA-256 request fingerprint and a bounded request ID. The adapter contract must atomically reserve/replay the (app, tenant, user, requestId) key inside the same tenant transaction; a matching replay returns the original result without rerunning the domain mutation, while a different fingerprint returns a conflict.
- The service fails closed if the adapter is absent or returns an unknown state. No production MariaDB idempotency adapter or migrated business write endpoint is claimed until its unique-key/locking behavior is implemented and integration-tested.
