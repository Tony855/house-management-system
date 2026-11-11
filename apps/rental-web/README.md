# Rental Portal

独立租房前端入口：`index.html` + `portal.js`，固定 audience `rental`，独立 cookie contract `rental_session`。

- API service factory: `services/rental-api/app.js`
- Tenant DB resolution: verified auth context → platform tenant registry → secret provider → tenant pool.
- Frontend does not read/write browser localStorage or sessionStorage.
- Shared `apps/portal.css` is presentation only.

当前是独立入口/UI shell 与 API boundary foundation；业务模块、登录/刷新会话、权限导航、真实租房 API 路由和 database-per-tenant 生产切换仍待完成。
