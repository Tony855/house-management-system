# Property Portal

独立物业前端入口：`index.html` + `portal.js`，固定 audience `property`，独立 cookie contract `property_session`。

- API service factory: `services/property-api/app.js`
- Tenant DB resolution: verified auth context → platform tenant registry → secret provider → tenant pool.
- Frontend does not read/write browser localStorage or sessionStorage.
- Shared `apps/portal.css` is presentation only.

当前是独立入口/UI shell 与 API boundary foundation；业主、物业费、抄表、网络和维修业务路由、登录/刷新会话和 database-per-tenant 生产切换仍待完成。
