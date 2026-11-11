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


### Tenant-local identity migration (expand/copy/verify only)

- The tenant migration SQL defines users, roles, settings, user permissions and effective role permissions inside each tenant DB. Usernames are unique only within that tenant DB, so equal usernames across tenants remain valid.
- Legacy sessions are deliberately excluded. Existing tokens must be revoked and users must authenticate again through platform-side platform_product_sessions.
- The identity migration normalizer validates source org and product scope, copies only users in that org/product, includes only referenced tenant roles and referenced built-in roles, and resolves permissions using the legacy rule: tenant override wins, otherwise the global default template is copied.
- Password hashes are preserved as opaque hashes; no plaintext credential is read or logged. User IDs and role IDs remain local to each isolated tenant DB.
- Migration is dry-run by default and requires a transactional target writer, read-back verifier and durable audit in copy mode. It never performs cutover or deletes source rows. Production MariaDB identity adapters, legacy login replacement, cross-tenant live authentication and backup/rollback rehearsal remain acceptance gates.


### MariaDB write idempotency

- The tenant write service now computes the SHA-256 fingerprint server-side from a bounded canonical JSON payload; clients cannot choose a fingerprint to disguise changed input.
- Transaction-scoped repository handles expose parameterized SQL execution only inside the transaction callback, allowing the idempotency adapter to participate in the same InnoDB transaction as the domain write and audit.
- Migration 002 adds a tenant-local unique request key and serialized response. The MariaDB adapter uses INSERT IGNORE plus SELECT FOR UPDATE, then commits the completed response atomically with the business mutation. Concurrent retries serialize on the unique key; a changed fingerprint conflicts, and a failed mutation rolls back the reservation.
- This adapter is available for wiring but is not enabled by default. A product route must supply it to the write service and compute the canonical payload only after domain validation.


## Tenant-local product login (new foundation)

- Product login resolves the exact request hostname through the platform-owned `platform_tenant_login_hosts` mapping; request body, query parameters and headers cannot supply a tenant UUID.
- Password verification reads only the selected tenant database's `users` row. A same-named user in another tenant is never searched.
- Successful login issues a short-lived HS256 token with fixed product audience, tenant UUID, user subject and random session ID; the platform session row is written before the token is returned.
- Logout revokes the exact session/user/tenant/product tuple. The existing authenticator checks the same tuple and expiry on every authenticated request.
- Migration `004_tenant_login_hosts.sql` adds exact host mappings; host mapping management remains a platform-admin deployment task and must not be exposed to tenant users.
- This is the password/session foundation, not complete production authentication: MFA enrollment/challenge, durable distributed login throttling, refresh-token rotation, account lockout policy and real signing-key manager integration remain required before production cutover. No login domain or signing secret is provisioned by this code.


### First tenant-scoped business write: Rental room creation

- Rental now mounts `POST /api/rooms` as a product-specific route; it is not generic CRUD and does not accept client-controlled `id`, `org_id`, timestamps or arbitrary columns.
- The DTO validates building ID, room number, monetary values, room status, room type, dorm capacity and bounded remarks. The route checks the building and duplicate room number inside the same transaction used for the write.
- It locks the parent building before the duplicate check, serializing concurrent room creation within one building while the legacy schema's duplicate-room constraint is still being assessed.
- The route requires the injected `req.tenantWrite` capability and forwards the operation reason, step-up token and idempotency key to the authorization/audit/idempotency boundary. If the production write service is not configured, it returns `503 TENANT_WRITE_UNAVAILABLE`.
- This is the first mounted business write route, not a production-enabled workflow: production authorization, MFA/step-up issuer, audit sink, idempotency store and MariaDB write integration must be wired and tested before enabling it for customers. Hotel and Property write workflows remain read-only.

### Runtime and dependency compatibility

- The current npm registry latest tags remain Express 5.3.0 and mysql2 3.24.6; the lockfile already resolves those releases, so no speculative package bump was made.
- CI now runs the complete Node test suite and production dependency audit on both supported LTS lines (Node 24.22.2 and Node 26.13.0). The MariaDB API integration remains pinned to Node 24.22.2 until the Node 26 matrix proves compatibility.
- Runtime support remains constrained to Node >=24 and <27. Major-version upgrades beyond that range require a separate compatibility and deployment rehearsal.


### Product-specific room creation endpoints

- Rental, Hotel and Property now each mount a distinct `POST /api/rooms` route under the authenticated product API boundary.
- Hotel accepts hotel-only daily pricing and booking/cleaning statuses; Property accepts property fees, utility prices and an optional owner reference. Each product rejects fields belonging to another product.
- Each route requires the injected tenant write service, operation reason, step-up token and idempotency key. It locks the building, rejects duplicate room numbers and validates Property owner references within the tenant database transaction.
- The route modules do not enable writes by themselves. Production remains fail-closed until the API process is supplied with real authorization, step-up, audit and MariaDB idempotency adapters. Current unit tests cover DTO contracts; real three-product MariaDB write integration remains a release gate.

### Dependency maintenance

- Dependabot is already configured for weekly npm and GitHub Actions updates on the independent refactor branch, with a bounded pull-request queue.
- CI validates the locked dependency graph on Node.js 24 and 26 and runs the production dependency audit. Dependency updates still require CI and security review before merge.


### Product-specific room creation routes (guarded, not production-enabled)

- Rental, Hotel and Property now expose a dedicated `POST /api/rooms` route with strict per-product DTO allowlists. Hotel accepts daily pricing and hotel room states; Property accepts owner/property-fee and utility pricing; Rental accepts monthly rent/deposit and rental fields.
- The routes lock the parent building, reject duplicate room numbers, validate Property owner references, and insert only through the product tenant repository inside the tenant write transaction. Client-supplied tenant/org IDs and cross-product fields are rejected.
- Mounted API tests now exercise Hotel and Property composition roots, tenant-context resolution, product-specific SQL column projections, owner-not-found rollback, and fail-closed behavior when no write service is configured.
- These routes remain unavailable for production mutation until each deployed product injects real authorization, MFA/step-up, durable audit and MariaDB idempotency adapters, and the per-tenant schema has been provisioned and verified. The MariaDB idempotency adapter is implemented; its production use still depends on applying migration 002 to each tenant DB and wiring the real adapters into the product API deployment.


### Real MariaDB room-write integration gate

- CI creates disposable per-tenant databases by cloning each product's legacy table definitions and removing the legacy `org_id` column, matching the tenant-copy contract. It does not alter the source product databases.
- The integration test applies tenant migration 002 and exercises the actual Rental, Hotel and Property Express composition roots with MariaDB-backed tenant pools, the transactional write service, SQL audit writes and the MariaDB idempotency adapter.
- Coverage includes concurrent duplicate request delivery, idempotent replay, same-key/different-payload conflict, duplicate room rejection, missing building, Property owner validation, and rollback when the commit-audit adapter fails.
- CI uses explicit test-only authorization and step-up verifiers. These prove transaction orchestration and persistence behavior; they are not production MFA or policy implementations. Production deployments must inject real identity-bound authorization and step-up verifiers, a durable audit adapter, tenant-specific database credentials and tenant migrations before enabling writes.
- Disposable databases are removed in test cleanup. The test never copies or modifies production tenant data.


- The MariaDB write integration now provisions a unique test DB principal per tenant, grants only `SELECT/INSERT/UPDATE/DELETE` on that tenant database, and verifies that access to the shared legacy product database and DDL are denied. The API is exercised using this restricted principal rather than the MariaDB root account.


- The integration suite also asserts the exact least-privilege DML grant (without `ALL PRIVILEGES` or `GRANT OPTION`), absence of legacy `org_id` columns in the tenant schema, successful/denied authorization and step-up cases, and the precise started/committed/replayed audit event counts for concurrent retries.
- Audit failure assertions verify that both the room mutation and its idempotency row roll back. A CI fixture validation defect discovered in the first run (the synthetic room number exceeded the production 20-character limit) was corrected; the fixture now uses a valid short room number.

### Platform-side login failure throttling

- Product login now requires a persistent platform rate-limit adapter. It checks the exact normalized product/host/username identity before tenant lookup, records unknown-tenant and invalid-password failures, and clears that identity's counter only after a successful session has been persisted.
- The adapter in `server/platform-adapters.js` uses one atomic MariaDB `INSERT ... ON DUPLICATE KEY UPDATE` statement per failed attempt, avoiding a read-modify-write race and explicit row-lock deadlocks; it applies a bounded failure window and timed lockout. The platform database clock (`UTC_TIMESTAMP`) is authoritative for window and lockout calculations.
- Migration `005_login_attempt_rate_limit.sql` stores only an HMAC-SHA256 identity digest, never the raw username or hostname. Production must supply a dedicated random HMAC key of at least 32 bytes via the secret manager; do not reuse JWT signing keys, database passwords, or the general application secret.
- Missing or unavailable limiter storage fails closed with HTTP 503; an active lockout returns HTTP 429. Default policy is 10 failures in 15 minutes followed by a 15-minute lockout. The current identity key is product + normalized host + normalized username; this is account-targeted throttling, not a substitute for edge/IP rate limiting, bot protection, MFA, or credential-stuffing detection.
- CI runs adapter contract tests plus a real MariaDB integration test covering concurrent failure increments, lockout, and explicit counter clearing. The integration uses disposable CI identities and removes them in `finally`.
- Production rollout still needs an edge/IP rate limit, monitoring/alerting for lockouts, a retention/cleanup job for stale hashed buckets, HMAC-key rotation procedure, and deployment wiring for `loginRateLimitHmacKey`. MFA enrollment/challenge and recovery flows remain separate unfinished controls.


### Platform administrator MFA foundation (not yet production login wiring)

- services/platform-api/mfa.js implements RFC 4226/6238-compatible six-digit TOTP, a bounded ±1 time-step window, constant-time code comparison and monotonic counter replay rejection.
- Enrollment is pending for at most 10 minutes. A factor becomes active only after a valid TOTP confirmation; enrollment state is not treated as an authenticated MFA session.
- TOTP secrets are encrypted/decrypted only through an injected deployment encryption/KMS adapter. The database stores an opaque encrypted envelope, never a plaintext seed. Production must use envelope encryption backed by KMS/HSM and protect the key-encryption key outside the application database.
- Ten one-time recovery codes are generated at enrollment. Only HMAC-SHA256 digests using a dedicated recovery-code pepper are stored. Recovery codes are consumed atomically and cannot be reused; the pepper must be a dedicated random secret of at least 32 bytes.
- services/platform-api/mfa-store.js persists pending enrollments, active factors and recovery-code digests. TOTP replay prevention is a conditional database update, and factor activation/recovery-code replacement is transactional.
- Migration 007_platform_admin_mfa.sql adds the three platform-only MFA tables. CI applies and verifies these tables; unit tests cover RFC vectors, expiry, replay, one-time recovery and persistence transaction behavior.
- This is a security primitive and persistence adapter, not a complete production MFA rollout. It is not yet mounted into a platform-admin login/challenge endpoint or bound to platform sessions; assertPlatformAdmin still trusts the injected authenticator's mfaVerified claim. Do not claim Super Admin MFA enforcement from these helpers alone.
- Before production use, implement the platform admin identity/session schema and login challenge flow, enforce per-admin attempt throttling, require recent MFA timestamps for sensitive actions, add audited factor reset/recovery and alerting, wire a real KMS adapter, and run live MariaDB concurrency tests for TOTP/recovery consumption.
