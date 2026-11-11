# Platform API

独立平台控制面服务：只读写 platform_control 数据库中的平台管理员、产品目录、租户 UUID、租户生命周期和 secret reference。不得读取租户业务 DB、租户用户/客户/账单/文件；Provisioner 使用独立高权限身份且不暴露给普通 API。

当前为服务边界说明，现有 server/app.js 尚未拆分接入。