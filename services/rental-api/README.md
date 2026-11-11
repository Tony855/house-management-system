# Rental API

独立服务边界：仅接受 audience=rental 的租户会话；仅访问租户专属 rental 数据库；独立部署、密钥、cookie/session 策略、限流和迁移版本。平台控制面仅通过受控 registry/secret adapter 提供租户元数据，不授予业务 API 平台数据库或其他租户数据库权限。

当前为服务边界说明，现有 server/app.js 尚未拆分接入。