# Super Admin Portal

独立平台超级管理员前端应用边界。只调用 platform-api，不加载业务产品前端，不持有租户数据库凭据。

- App audience: `platform`
- API service: `platform-api`
- Platform data: administrator identities, product catalog, opaque tenant registry and lifecycle metadata only
- No tenant customers, employees, tenant passwords, contracts, invoices, uploaded documents or arbitrary tenant SQL.

This directory is an application boundary scaffold, not a production-ready portal yet.
