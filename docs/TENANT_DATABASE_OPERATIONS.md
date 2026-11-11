# Tenant database runtime and cutover operations

## Runtime boundary

Each Rental, Hotel and Property API must receive an authenticator that verifies signature, issuer, expiry, session revocation, product audience and tenant binding. The product app ID is fixed in the service composition; request body, query parameters and X-Tenant-ID must never select a tenant.

Tenant resolution reads the active tenant row from the dedicated Platform DB and retrieves credentials by secret reference. Tenant pool keys are isolated by product, tenant, host, port, database, user, credential version and a one-way password fingerprint. The pool manager enforces a global pool cap, idle expiry, per-tenant invalidation and a mysql2-compatible close contract.

The pool manager accepts only the three product app IDs and UUID tenant IDs, validates database identifiers, host, port and credential bounds, and rejects malformed pool adapters. Keep the pool cap aligned with MariaDB connection budgets: maximum possible tenant pools multiplied by per-pool connection limit must not exceed the DB server's connection budget after reserving capacity for Platform, migrations, monitoring and administration.

## Provisioning sequence

1. Create a non-active provisioning tenant registry record.
2. Persist provisioning_started audit event.
3. Create the deterministic tenant database and tenant-scoped DB principal.
4. Grant privileges only on that tenant database.
5. Store generated credentials in the external secret manager.
6. Apply the product's versioned schema manifest.
7. Verify DB identity, grants and cross-tenant denial with the tenant principal.
8. Persist provisioning_verified audit event.
9. Only then mark the tenant active.

If any stage fails, cleanup is attempted in reverse order using deterministic resource names. A cleanup or audit failure is surfaced and the tenant must remain non-active. Operators must reconcile orphaned resources before retrying provisioning.

## Data migration and cutover

The current migration adapters support read-only org-scoped source snapshots, non-destructive dry runs, transactional imports into empty tenant databases, read-back verification and per-table row-count/SHA-256 manifests. They do not perform production routing cutover or delete legacy records.

For each tenant:
- Take a recoverable backup and record source org ID, product, tenant UUID and source schema version.
- Run dry-run and review row counts, relationship checks and checksums.
- Provision an empty target DB with the target tenant principal.
- Copy in a maintenance window or from a controlled consistent snapshot.
- Verify target read-back checksums and critical business totals.
- Validate authentication, permissions, files, caches, jobs, exports and WebSocket ownership.
- Switch routing only through an audited, reversible registry state change.
- Retain the legacy source and rollback routing until post-cutover reconciliation passes.
- Never drop legacy data as part of the initial cutover.

## Operations still required before production

- Configure a dedicated Platform DB user and per-tenant DB users with least-privilege grants in the actual hosting environment.
- Integrate a production secret manager and KMS/HSM; test rotation and denied access.
- Add a production migration orchestrator, durable migration job state, operator approval and resumable reconciliation.
- Add per-tenant backup scheduling, restore verification, retention and disaster-recovery runbooks.
- Measure pool count, queue depth, connection use and tenant-level query latency under realistic concurrency.
- Run a cross-tenant penetration suite covering every product route, background worker, file path, export, cache key and realtime channel.
- Complete product-by-product migration rehearsal, balance reconciliation and rollback drills before activating any production tenant DB cutover.

## Current acceptance boundary

Unit tests and CI MariaDB jobs validate pool lifecycle, schema adapters, migration transactions and platform schema contracts. This is not proof that a production tenant has been migrated or that the legacy business runtime has been cut over. The legacy server/app.js remains the existing business entrypoint until the independent product APIs and their repositories are fully wired and deployment-tested.
