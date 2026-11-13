# Tenant migration worker and product API progress

## Durable migration execution

The platform control database now stores idempotent tenant migration jobs with atomic worker leases, lease renewal, bounded JSON checkpoints, attempt counts, failure codes, and compare-and-set retry/cancel transitions. `server/tenant-migration-worker.js` executes one claimed job through an injected executor, exposes heartbeat/checkpoint callbacks, and refuses to mark completion after lease loss.

The platform API exposes:
- `POST /api/platform/tenant-migrations` to enqueue a dry-run or copy job. Requires platform tenant-write permission, recent MFA/step-up, an action reason, and an idempotency key.
- `GET /api/platform/tenant-migrations/:id` to inspect a job with tenant-read permission.
- `POST /api/platform/tenant-migrations/:id/retry` to retry a failed job with its expected attempt count.
- `POST /api/platform/tenant-migrations/:id/cancel` to cancel a queued job.

These endpoints manage durable job state. A production executor still must be wired to the tenant-specific source/target credential providers, schema migrator, identity/file migrators, and operator approval/cutover workflow. No production data is copied by merely enqueueing a job.

## Product API write coverage

Rental, Hotel, and Property now expose audited `PUT /api/rooms/:id` updates through the existing tenant write service. The route locks the tenant-local room row, merges a strict product-specific patch, validates parent building and property owner references, rejects duplicate room numbers, and writes through the transactional repository. It does not add destructive room deletion; historical billing, contracts, orders, meters, and repair relationships require a separate archival/deletion policy.

## Validation

The tenant-isolation test suite includes migration worker lifecycle, platform migration route authorization, and product room update tests. MariaDB migration CI installs the durable job schema. These tests do not replace real provider integration, full product CRUD, migration execution against a production-sized tenant, or cross-tenant penetration testing.

## Durable worker orchestration

The control-plane job store now exposes a bounded, oldest-first runnable-job query (queued jobs and jobs whose leases expired). The runner polls that queue, enforces a process-wide concurrency ceiling, suppresses duplicate local dispatch, prevents overlapping polling ticks, reports sanitized operational error codes, and drains active work on graceful shutdown. The executor remains an explicit injected dependency: deployments must still provide tenant-scoped source/target adapters and an operator-approved execution policy before enabling copy jobs.


## Executor and platform worker wiring

The platform API can now be given an explicit `migrationExecutor` dependency. When supplied, it creates the durable job store, worker and bounded polling runner, and exposes `app.locals.stopTenantMigrationRunner()` for graceful shutdown. When omitted, no worker starts. The concrete `createTenantDataMigrationExecutor` resolves source/target connections through an injected resolver, uses the MariaDB adapters and snapshot verifier, checkpoints phases, heartbeats long-running work, and closes resolved resources. The resolver must enforce a read-only legacy source principal and tenant-database-only target principal; no connection credentials are accepted from a job or API request. Production deployments must inject a real Secret Manager-backed resolver and durable audit sink. This remains a copy/dry-run mechanism, not a cutover or source deletion mechanism.


## Product API and portal increment

Rental, Hotel and Property APIs now mount a shared tenant-scoped building writer: create and partial/full update use the existing audited/idempotent tenant write service, lock rows, reject duplicate names and accept only name/address/remark fields. Room update supports both PUT and PATCH through one validation/transaction handler. Portal entrypoints now render a data overview after authentication, querying only the current product's permitted read APIs; platform portal uses platform-only list endpoints. The overview is a read-only operational summary, not a substitute for complete business management screens.


## Platform runtime injection and shutdown

The production Platform API runtime accepts an explicit `migrationConnectionResolver`. Only when deployment supplies this resolver does runtime construct the concrete MariaDB tenant-data executor and enable queue polling; without it the worker remains disabled. Runtime shutdown first drains/stops the migration runner and only then closes the Platform DB pool. The resolver is the trust boundary for obtaining a legacy read-only connection, tenant-scoped target connection, and durable audit adapter. A deployment must not enable copy mode until those principals and audit retention have been independently verified.


## Idempotency resource scoping

All product write routes add a server-defined `__resource` discriminator to the canonical idempotency payload (buildings, rooms, tenants, or repairs). This prevents the same tenant/user request key and otherwise-identical JSON payload from replaying a response produced by a different resource endpoint. The discriminator is generated by the route, never accepted from client input, and is not persisted as a business-table column.


## Worker lease fencing

Tenant migration leases now carry a unique per-claim UUID fencing token in addition to the human-readable worker ID. Every heartbeat, checkpoint, completion and failure write must match both the worker ID and the current lease token; reusing a worker ID after restart cannot let a stale process renew or complete a lease reclaimed by another attempt. Migration 018 backfills tokens for jobs that were already running when the column is introduced.

For deployment, stop and drain all migration workers before applying migration 018 and deploying the token-aware worker code. Do not run old and new worker binaries concurrently across this schema transition. Re-enable workers only after the migration and application rollout are complete. MariaDB CI now verifies that an old token is rejected after a same-worker-ID lease reclaim.
