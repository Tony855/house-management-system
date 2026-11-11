# Hotel API

独立服务边界：仅接受 audience=hotel 的租户会话；仅访问租户专属 hotel 数据库；独立部署、密钥、cookie/session 策略、限流和迁移版本。

当前为服务边界说明，现有 server/app.js 尚未拆分接入。