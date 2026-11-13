# Platform API

独立平台控制面服务。平台总管理 Super Admin 的唯一后端入口；只访问独立 platform_control 数据库和 secret-manager references，不访问租户业务 DB。

## Responsibilities
- Platform-admin authentication, platform audience and MFA enforcement.
- Product catalog, plan/price versions, subscription lifecycle and entitlements.
- Platform billing accounts, platform invoices, payment transaction state, verified webhook event IDs, refunds, append-only revenue ledger and audit trail.
- Tenant UUID registry, lifecycle/provisioning orchestration and sanitized health/usage aggregates.

## Authentication composition
- `admin-auth-dependencies.js` 提供平台认证依赖组合入口：platform DB pool、KMS encryption adapter、独立 recovery pepper、独立登录限流 HMAC key、签名/验证 key providers 和 issuer 均必须显式注入。
- 组合结果中的 `authService` 可传给 `createPlatformApi({ pool, adminAuthService })`，挂载 password login、MFA challenge、step-up 和 logout routes。
- 登录限流使用 platform 独立 namespace；用户名和 host 仅以专用 HMAC 摘要持久化。DB/KMS/限流器故障时认证 fail-closed。
- Migrations 008/009 增加管理员挑战/会话表及平台限流 namespace。009 是对已存在数据库的前向迁移。
- 生产仍必须提供真实 KMS/HSM、独立密钥轮换、首个 Super Admin 安全 bootstrap、MFA enrollment/recovery 管理流程、cookie/CSRF policy、审计和 live MariaDB auth E2E。没有这些不能宣称生产认证已启用。

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
Platform API app, auth composition, routes, repositories and billing primitives exist. Payment provider integration, webhook route/signature enforcement, invoice scheduler, reconciliation worker and full Super Admin billing UI remain pending. Do not claim online collection or automated billing is active.
