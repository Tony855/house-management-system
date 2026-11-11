# Platform API

独立平台控制面服务。平台总管理 Super Admin 的唯一后端入口；只访问独立 platform_control 数据库和 secret-manager references，不访问租户业务 DB。

## Responsibilities
- Platform-admin authentication, platform audience and MFA enforcement.
- Product catalog, plan/price versions, subscription lifecycle and entitlements.
- Platform billing accounts, platform invoices, payment transaction state, verified webhook event IDs, refunds, append-only revenue ledger and audit trail.
- Tenant UUID registry, lifecycle/provisioning orchestration and sanitized health/usage aggregates.

## Billing module
- Migration: db/migrations/platform/002_platform_billing.sql (after 001 registry migration).
- Pure domain rules: billing-domain.js.
- Amounts use ISO currency minor units; KHR has two decimal places, USD two, KWD three.
- Invoice/payment transitions, webhook idempotency and refund-balance rules are explicit.
- Tenant operational invoices and customer payment records remain in each tenant database.

## Security boundary
- Only authenticated platform-audience sessions may invoke platform routes.
- Product APIs cannot access this database; the platform API cannot browse tenant data.
- Database stores provider secret references, not provider secrets.
- Refunds/manual adjustments require elevated platform permission, MFA/step-up verification, reason and audit.
- No tenant-provided database name, SQL, secret reference or arbitrary tenant query is accepted.

## Current status
The migration and pure domain primitives are committed, but this directory is not yet a running API. Authentication middleware, database repositories, payment-provider adapters, invoice scheduler, webhook route, reconciliation worker and frontend integration remain pending. Do not claim online collection or automated billing is active.
