# 四应用与租户级物理数据隔离架构

> 本方案将“独立应用”定义为独立前端构建、独立 API 服务、独立身份域和独立发布单元。
> 将“完全隔离”定义为每个业务租户拥有独立数据库、数据库账号、密钥、文件空间、缓存命名空间、备份与审计边界。
> 现有系统尚未完成该架构迁移；本文是目标架构与迁移验收契约。

## 1. 最终拓扑

四个独立产品：
- Rental：租房前端 + rental API + rental control/tenant provisioning。
- Hotel：酒店前端 + hotel API + hotel control/tenant provisioning。
- Property：物业前端 + property API + property control/tenant provisioning。
- Super Admin：超级管理员前端 + platform API + platform registry。

三个业务产品各自管理多个经营主体。每一个经营主体/租户都拥有独立数据平面：

```
Platform Control Plane (Super Admin only)
  platform identity DB | product catalog | tenant registry | billing metadata
  tenant registry: tenant_uuid, app_id, db_name, db_secret_ref, lifecycle_state
  NO tenant customers / staff / passwords / contracts / invoices / files

Rental App/API
  Rental Tenant A -> rental_a DB + db user A + encryption key A + file bucket A
  Rental Tenant B -> rental_b DB + db user B + encryption key B + file bucket B
  Rental Tenant C -> rental_c DB + db user C + encryption key C + file bucket C

Hotel App/API
  Hotel Tenant A -> hotel_a DB + db user A + encryption key A + file bucket A
  Hotel Tenant B -> hotel_b DB + db user B + encryption key B + file bucket B

Property App/API
  Property Tenant A -> property_a DB + db user A + encryption key A + file bucket A
  Property Tenant B -> property_b DB + db user B + encryption key B + file bucket B
```

No shared customer/tenant employee identity tables across business tenants. Identical usernames in two tenants are allowed and resolve only inside their own tenant database. A person who works with two tenants must receive two separate tenant accounts and sessions; no implicit cross-tenant identity linking.

## 2. Data ownership matrix

| Data | Storage owner | Cross-tenant sharing |
|---|---|---|
| Platform super-admin accounts and MFA | Platform DB | Never |
| Product catalog, tenant UUID, lifecycle, DB secret reference | Platform DB | Metadata only |
| Tenant admin/staff/company-admin accounts, password hashes, roles, permissions, sessions | Tenant DB | Never |
| Customers, tenants/guests/owners, employee records | Tenant DB | Never |
| Buildings, rooms, properties, contracts, reservations, orders | Tenant DB | Never |
| Invoices, payments, refunds, meter readings, utility and network records | Tenant DB | Never |
| Settings, currency, FX rates, price lists, templates | Tenant DB | Never |
| Audit events and export jobs | Tenant DB | Never; platform sees only health/usage aggregates |
| Uploads, ID documents, images, attachments | Tenant-specific bucket/container + key | Never |
| Cache, queues, search indexes, websocket channels | Tenant-scoped credentials/namespaces | Never |
| Backups and restore points | Per-tenant encrypted backup set | Never |

The platform tenant registry must not become a shadow user/customer database. It stores opaque tenant IDs, product, lifecycle state, database location and secret-manager reference only. Platform billing records contain platform subscription/payment data only, not tenant invoices or tenant customer payment records.

## 3. Isolation levels and mandatory controls

### 3.1 Database-per-tenant (mandatory)
- One tenant = one dedicated database/schema, e.g. `rental_<opaque_uuid>`; never place multiple tenants' business rows in the same tenant database.
- Provision one DB principal per tenant. Its grants are limited to that tenant database; it cannot read another tenant DB or platform DB.
- API obtains DB credentials from a secret manager using a server-side tenant registry lookup. Never accept database name, host, username, tenant UUID, org ID, schema, or secret reference from browser input.
- Tenant resolution order: validated application host/app identity -> authenticated tenant-scoped login -> server-side registry lookup -> tenant DB pool. Never trust arbitrary `X-Tenant-ID`, query string, request body, or localStorage.
- Use a bounded pool cache with idle eviction; revoke and close pools on tenant suspension/deletion/credential rotation.
- Unknown app, tenant, lifecycle state, database mapping, or secret reference fails closed. No fallback to rental, default tenant, shared DB, or first available tenant.
- Platform API credentials cannot be reused by business API. Business API DB principals cannot query platform registry or another tenant DB.

### 3.2 Independent identity and sessions
- Super-admin identity exists only in Platform DB and authenticates only at Super Admin app/API.
- Each tenant's admin, staff, company admin, customer portal identities (if enabled), role catalog, permission grants and sessions live inside that tenant DB.
- Session includes immutable `app_id`, `tenant_uuid`, `user_id`, issued/expiry/revocation metadata. Server validates all claims against the resolved tenant database on every request.
- Separate signing/encryption keys per product and tenant. Do not accept a token from another product or tenant.
- Password reset, tenant suspension, user deactivation, role changes and logout revoke appropriate sessions.
- Do not globally deduplicate users by email/phone/username. Do not expose account existence in another tenant.

### 3.3 Files and exports
- Use per-tenant bucket/container or storage account where practical; at minimum a unique unguessable tenant prefix with storage IAM policy and per-tenant KMS key.
- Never serve uploads via an unrestricted static directory. Download must authorize session + tenant + record ownership and issue short-lived signed URLs.
- Export, report, temp file and generated document paths are tenant-scoped; background jobs carry immutable tenant context.
- Backups encrypted with tenant-specific keys; restore drills must prove a tenant can be restored without importing another tenant's data.

### 3.4 Cache, queues, logs and realtime
- Redis keys and channels are tenant-prefixed and tenant-authenticated; queue payloads include tenant UUID and app ID, verified again by workers before DB access.
- No global cache key for customer, room, invoice or user data.
- Tenant logs are separated by access policy. Platform monitoring receives health and aggregate counters only, never customer PII, credentials or document contents.
- Metrics labels must avoid usernames, phone numbers, IDs or other high-cardinality PII.

### 3.5 Platform/super-admin boundary
- Super Admin can provision/suspend tenants, rotate DB credentials, view service health and aggregate usage.
- Super Admin cannot list tenant customers/users, open tenant invoices, browse uploaded files, or run arbitrary SQL against tenant DBs.
- Emergency support access, if ever introduced, must be disabled by default, time-limited, tenant-approved, reason-bound, audited and read-only by default. It is not part of ordinary super-admin access.

## 4. Four separately deployable applications

```
apps/
  rental-web/       # independent entry, routing, layouts, styles, build
  hotel-web/
  property-web/
  super-admin-web/
services/
  rental-api/       # rental auth + tenant resolver + rental domain modules
  hotel-api/
  property-api/
  platform-api/     # super-admin auth + provisioning + registry
packages/
  ui-kit/           # generic presentation only; no shared business state
  contracts/        # versioned API contracts and validation schemas
  telemetry/        # redaction-safe telemetry
infra/
  migrations/
  provisioning/
  secrets/
  deployment/
```

Rules:
1. Each web app has its own HTML entry, route tree, auth client, session cookie name, CSP, build artifact, release version and deployment pipeline.
2. Each API has its own origin/service identity, credentials, rate limits, signing keys and database access policy.
3. Shared packages may contain presentation primitives and generated API types only. No shared mutable auth store, business models, tenant cache or cross-product domain services.
4. The super-admin frontend is not a mode inside the business SPA. It is a separate deployment and cannot load business application bundles.
5. No cross-product navigation that silently reuses the current token. A different product requires a fresh login at that product's origin.
6. API authorization is authoritative; front-end route guards are only UX.

## 5. Tenant provisioning lifecycle

1. Super-admin creates a product tenant in Platform DB. Registry generates a cryptographically random opaque tenant UUID.
2. Provisioner creates a database with strict naming/quoting rules and a dedicated DB principal restricted to that database.
3. Provisioner applies only that product's versioned migrations; no tenant data is seeded from another tenant.
4. Provisioner creates tenant-specific encryption key, object-storage namespace, cache namespace, backup policy and secret-manager entry.
5. Tenant-local bootstrap creates the first tenant admin with one-time enrollment/password setup. No shared default password.
6. Provisioner runs isolation smoke tests, verifies grants and writes a provisioning audit record.
7. Only after all checks pass does registry mark tenant `active` and issue its login route.
8. Suspend disables login, revokes sessions, blocks API and signed-file access; it does not delete data.
9. Delete is a separately approved, delayed, irreversible workflow with export/retention/legal-hold checks, backup policy and a second confirmation. No synchronous cascade delete.
10. Restore/credential rotation is tenant-specific and audited.

Provisioning must be idempotent and resumable. Partial failure leaves the tenant `provisioning_failed`, not active.

## 6. Migration from current shared schema

Current baseline has a shared `house_sys` containing `orgs/users/roles/settings/sessions` and three shared product databases whose business tables use `org_id`. This is not database-per-tenant isolation.

Migration must be expand -> copy -> verify -> switch -> contract:

### Phase A — inventory and freeze
- Snapshot production and verify restore.
- Inventory every table, foreign key, unique key, trigger, view, scheduled task, upload path and API route.
- Build a tenant ownership manifest: current `org_id` -> product -> new tenant UUID -> destination DB.
- Stop destructive init paths from being usable in production; preserve old schema read-only for rollback.

### Phase B — provisioning foundation
- Add Platform DB and tenant registry with opaque IDs and secret references.
- Implement tenant provisioner, per-tenant DB users/grants, secret manager, pool lifecycle and migration runner.
- Add product-specific API service identities and app audiences.
- Keep legacy application running while provisioning test tenants.

### Phase C — tenant data extraction
For each existing org:
- Create destination tenant DB from product-specific schema migrations.
- Move the org's users, roles, role permissions, settings, sessions (sessions should normally be revoked, not copied), customers, employees, domain rows, audit history and file objects.
- Rewrite internal foreign keys/IDs only through an explicit mapping table; preserve externally visible business numbers.
- Verify counts, sums, references, unique constraints, file checksums, and orphan records.
- Revoke old sessions and require re-login after cutover.
- Do not move platform super-admin credentials into any tenant DB.

### Phase D — dual-read validation, then cutover
- Prefer shadow verification/CDC or controlled read-only comparison; do not permit uncontrolled dual writes.
- Route a small set of test tenants to the new services, run full workflows and cross-tenant negative tests.
- Cut over one tenant at a time; maintain a tested rollback route before retiring old writes.
- After the rollback window and owner sign-off, remove legacy shared business tables and org_id-based cross-tenant access code.

### Phase E — legacy retirement
- Remove shared users/roles/sessions for business users from Platform DB.
- Remove old single-SPA entry and shared multi-mode API.
- Retain only minimal platform registry/metadata in Platform DB.
- Delete old data only after verified backup, retention checks and explicit approval.

## 7. Mandatory isolation test matrix

For each product pair (rental/hotel/property/super) and each tenant pair (A/B):
- A's valid token against B's host/API must fail before any tenant DB query.
- A's token against B's DB principal must be denied by MariaDB grants.
- A cannot read, search, update, delete, export or infer B's user/customer/room/contract/order/invoice/payment/file IDs.
- Same username/email/phone in A and B remains two independent identities.
- A background job, websocket, cache lookup, signed URL and report export cannot be redirected to B by changing payload/query/header.
- Missing tenant context, unknown tenant, stale registry mapping, disabled tenant or unavailable secret fails closed.
- Super-admin token cannot call tenant business APIs or obtain tenant DB credentials.
- Tenant DB principal cannot query platform registry or another tenant DB.
- Tenant deletion/suspension/rotation invalidates sessions, cached pools, queued work and signed URLs as specified.
- A tenant backup can be restored in isolation with matching record counts and checksums.

## 8. Rollout gates

No production cutover until:
- All four apps build and deploy independently.
- All three business APIs use tenant-specific DB credentials.
- Platform API has no general tenant DB read credentials.
- 100% of tenant-owned tables/files/cache/queues have documented owner and tenant boundary.
- Automated cross-product and cross-tenant negative tests pass.
- Migration reconciliation has zero unexplained count/sum/reference/checksum differences.
- Backup restore and rollback drills pass.
- Security review confirms no tenant-controlled DB routing or secret exposure.

## 9. Immediate code hardening already started

The legacy DB router previously returned the rental pool for an unknown mode. That fallback is unsafe. The refactor branch now rejects unsupported database modes. This is an interim fail-closed guard only; it does not by itself deliver database-per-tenant isolation.
