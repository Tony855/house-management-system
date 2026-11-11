# Independent application and service boundaries

## Application entrypoints

- Rental: `apps/rental-web/index.html` + `portal.js`, audience `rental`, cookie contract `rental_session`.
- Hotel: `apps/hotel-web/index.html` + `portal.js`, audience `hotel`, cookie contract `hotel_session`.
- Property: `apps/property-web/index.html` + `portal.js`, audience `property`, cookie contract `property_session`.
- Super Admin: `apps/super-admin-web/index.html` + `portal.js`, audience `platform`, cookie contract `platform_session`.

The entrypoints are separate static applications and do not import the legacy shared browser bundle or read/write localStorage/sessionStorage. `apps/portal.css` is a shared presentation stylesheet only; it does not share application state or credentials.

The current portal pages are architecture/UI shells. Business screens, real login/session refresh, permission-aware navigation, production API URLs, CSP and per-origin cookie issuance are not yet wired. The health probe is not authentication and must never be treated as proof of a user session.

## Product API composition

- `server/product-api.js` builds a product API only when a verified authenticator, platform tenant registry, secret provider and tenant pool manager are injected.
- `services/rental-api/app.js`, `services/hotel-api/app.js`, and `services/property-api/app.js` pin the service audience in code.
- Authentication must validate JWT/session signature, issuer, expiry, audience and app ID before setting `req.auth`.
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

The Platform API currently exposes read endpoints for overview, products, plans, tenants, invoices and revenue ledger, plus draft plan creation. Payment provider adapters, webhook signature verification, subscription lifecycle commands, invoice issuance/collection scheduler, refund execution and reconciliation remain unimplemented. Do not enable public billing writes or production collection until those controls exist.

## Isolation and rollout

1. Deploy the control-plane database separately from all tenant databases.
2. Wire an audited platform authenticator and secret manager.
3. Provision one product tenant at a time with unique DB principal and least-privilege grants.
4. Migrate that product's schema and data, compare row counts/checksums, and run cross-tenant denial tests.
5. Deploy product API routes only after their repository layer is tenant-pool-only.
6. Keep legacy APIs read-only during controlled cutover, then retire only after rollback window and backup restore drill.

No production DB migration or data deletion is performed by the CI jobs.
