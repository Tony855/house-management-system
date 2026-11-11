# Super Admin Portal

独立平台系统总管理应用，只调用 Platform API，不加载业务产品前端，不持有租户数据库凭据。

- App audience: platform
- API service: platform-api
- Identity: platform admins with mandatory MFA
- Platform data: product catalog, opaque tenant registry/lifecycle, subscription and platform billing metadata
- Forbidden: tenant customer/employee/guest/owner accounts, tenant operational invoices, tenant files and arbitrary tenant SQL

## Planned platform navigation
1. Platform overview: tenant counts, product health and aggregate platform revenue.
2. Products & plans: Rental / Hotel / Property catalog, plan versions, prices, cycles, quotas and entitlements.
3. Tenant management: provisioning, suspension, reactivation and health metadata.
4. Subscriptions: trial, active, past-due, paused and cancellation lifecycle.
5. Platform invoices: invoice list, issue/void, overdue and downloadable statements.
6. Payments & refunds: verified provider transactions, reconciliation, refund approvals and idempotency.
7. Revenue ledger: immutable financial entries and period/currency reports.
8. Security & audit: admin roles, MFA, billing changes and support access audit.

The billing migration and domain helpers are foundations only. This is not yet a production-ready frontend; no online payment or scheduled invoice collection is enabled.
