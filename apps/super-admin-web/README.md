# Super Admin Portal

独立平台总管理前端入口：`index.html` + `portal.js`，固定 audience `platform`，独立 cookie contract `platform_session`。

- API service factory: `services/platform-api/app.js`
- Dedicated DB pool: `server/platform-db.js`; requires `PLATFORM_DB_*`, never falls back to tenant or legacy DB credentials.
- Platform billing routes require platform audience, active admin, MFA and scoped permission. Plan writes require step-up verification and an action reason.
- Tenant list APIs expose opaque identity and lifecycle metadata only; DB host/name/secret reference are not serialized.
- Frontend does not read/write browser localStorage or sessionStorage.

当前是独立入口/UI shell。真实 MFA/session issuer、完整财务 UI、支付、Webhook、自动开票、退款执行、对账及生产部署尚未完成。
