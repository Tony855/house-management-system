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
