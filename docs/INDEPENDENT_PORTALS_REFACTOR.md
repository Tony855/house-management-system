# 独立前端入口与后端模块化重构方案

> 状态：审计基线与目标架构；实施分阶段推进。本文不代表重构已经完成。
> 基线：main @ af90e7959c32ab9d6e5b11732c8e942aac9abaec（2026-09-20）

## 1. 重构目标

把当前由 `public/index.html` 承载的四个入口、三套业务系统和超级管理员控制台拆成四个独立前端应用：

| 应用 | 建议路径/域名 | 登录主体 | 业务边界 |
|---|---|---|---|
| Rental Portal | `/rental/` 或独立域名 | rental 模式的 admin/staff | 租赁合同、租客、房源、租金、水电、网络、报修 |
| Hotel Portal | `/hotel/` 或独立域名 | hotel 模式的 admin/staff | 预订、入住/退房、房态、房费、清洁、报修 |
| Property Portal | `/property/` 或独立域名 | property 模式的 admin/staff/company_admin | 企业、物业资产、物业费、水电、网络、报修、投诉 |
| Super Admin Portal | `/super/` 或独立域名 | super | 经营主体生命周期、平台配置、平台监控、平台审计 |

四个应用必须分别构建、分别部署、分别加载入口和路由，不允许通过单一 SPA 的隐藏菜单或运行时 mode 切换模拟隔离。员工工作台作为各业务应用内部的独立受限布局，不新增第五个系统入口。

## 2. 目标仓库结构

```
apps/
  rental/                 # 独立入口、路由、布局、页面、样式、构建配置
  hotel/
  property/
  super-admin/
packages/
  ui/                     # 无业务权限的基础 UI
  api-client/             # API transport、错误处理、请求 ID
  auth-client/            # 应用级登录/登出/会话客户端
  contracts/              # API DTO、枚举、schema
server/
  app.js                  # 仅负责组装中间件、路由和启动
  config/
  middleware/             # auth、app audience、tenant scope、RBAC、validation
  modules/
    auth/
    organizations/
    rental/
    hotel/
    property/
    billing/
    monitoring/
    audit/
  infrastructure/
    db/                   # 显式按 mode 选择连接，不允许未知模式回退
    logging/
    security/
db/
  migrations/             # 只增量迁移；禁止在部署升级中 DROP DATABASE
  seeds/
public/                    # 仅保留必要的静态公共资源/兼容跳转
docs/
```

## 3. 前端独立性约束

1. 每个应用具有独立的 `index.html`、入口文件、路由树、页面布局、导航配置、主题和构建产物。
2. 各应用的构建产物互不引用其他应用的页面 chunk；共享包仅允许基础 UI、类型、无业务状态工具和 API transport。
3. 各应用在编译期固定 `APP_ID`（`rental | hotel | property | super`），不可由 URL query、localStorage 或请求参数改写。
4. 应用入口只提供本应用登录界面。租房账号不能在酒店入口成功登录，物业账号不能进入租房入口，超管只能从超管入口登录。
5. 登录后不可出现系统切换器；切换系统必须退出当前应用并从另一个应用入口重新认证。
6. 路由守卫只负责 UX；所有 API 必须独立执行服务端授权。
7. 每个应用单独定义 CSP、静态资源缓存策略、错误边界和版本信息。
8. 员工工作台属于各业务应用内的独立受限 layout，员工与主管理员共享应用入口，但权限和导航完全不同。

## 4. 身份、会话与授权边界

### 4.1 服务端认证

- 登录请求的 `app_id` 必须由应用入口固定传入；服务端将其与用户 `mode/level` 校验。
- 会话记录至少包含 `user_id`、`mode`、`org_id`、`audience`、`created_at`、`expires_at`、撤销状态。
- 数据库只存 Token 的 SHA-256 摘要，不存可直接重放的明文 Token。
- Cookie 在 HTTPS 下必须设置 `HttpOnly; Secure; SameSite=Lax`；若采用 Cookie 鉴权，写请求增加 CSRF 防护。
- 明确登出、密码重置、用户停用、租户关闭时的会话撤销策略。
- 登录限流迁移为共享存储/数据库限流，并按 IP、账号、入口组合限制；不能依赖单进程 Map。
- 认证错误对外统一，不泄露用户名属于哪个系统或租户。

### 4.2 每个请求强制验证

`session.audience === appId`、`session.mode === user.mode`、`session.org_id === user.org_id`。任一不一致立即拒绝并记录安全事件。禁止使用 `session_org || user.org_id` 这类会掩盖 NULL/不一致的回退逻辑。

### 4.3 授权规则

- 超管：只允许平台主体管理、平台配置、监控和审计 API；业务 API 一律 403。
- 主管理员：仅本 `org_id` 的本系统业务数据与本主体用户/角色/设置。
- 员工：权限完全由主体角色授权；页面访问与操作权限分别校验。统一选择“角色授权为唯一来源”，删除或迁移未使用的个人权限模型，不能使用角色权限与个人权限并集。
- 物业企业管理员：必须同时校验 `mode=property`、`org_id`、`company_id`；每条相关读写都验证目标房产/账单/抄表/报修等属于该企业。
- 未知角色、未知 mode、缺失租户上下文默认拒绝。

## 5. 数据访问与多租户隔离

继续保留共享身份库 + 三套业务库的物理边界，但重构 DB API：

- `getPool(mode)` 对未知或空 mode 抛出错误，禁止回退到 rental。
- 业务 Repository 必须显式接收不可变的 `TenantContext`，禁止从全局隐式上下文猜测租户。
- 每个业务表继续带 `org_id`；读写 SQL 必须按 org_id 限定；更新/删除必须同时限定主键和 org_id。
- 物业企业级数据查询必须同时限定 org_id 与 company_id/owner_id。
- 关键外键使用组合唯一键/约束，防止跨租户引用（例如 `(org_id, room_id)`）。
- 账单支付、入住/退房、合同状态、宽带变更等多步操作使用事务，并在并发写入时锁定目标记录。
- 为租户隔离建立自动化负向测试：租户 A 的 token 不得读取、修改、删除租户 B 的任意资源。

## 6. 后端模块化边界

每个业务模块采用 `routes -> controller -> service -> repository`：

- routes：HTTP 路由与中间件组合，不包含 SQL。
- controller：DTO 转换、HTTP 状态码，不包含业务规则。
- service：业务规则、事务边界、幂等性。
- repository：SQL 与数据映射，必须接收 TenantContext。
- validation：输入 schema 与枚举约束。
- audit：记录关键操作的操作者、租户、对象、前后差异、请求 ID。

第一阶段不拆成多个微服务；采用模块化单体，避免增加分布式事务、运维与部署复杂度。四个前端独立不等于必须四套后端或四个数据库实例。

## 7. 已确认的审计问题

| 编号 | 发现 | 风险 | 修复要求 |
|---|---|---|---|
| A-01 | `server/db.js:getPool` 对未知 mode 回退 rental | 高 | 改为 fail-closed，并增加非法 mode 测试 |
| A-02 | session 表保存明文 Bearer Token | 高 | 只保存 token hash，增加过期/撤销字段及迁移 |
| A-03 | session mode/org 与 users mode/org 未在认证时做一致性断言 | 高 | 比对 audience/mode/org_id，任何不一致拒绝 |
| A-04 | 登录限流与失败锁定使用进程内 Map | 中高 | 共享限流存储、清理策略、代理 IP 信任配置 |
| A-05 | Cookie 缺少 Secure 属性 | 中高 | HTTPS 环境 Secure、CSRF 与可信代理策略 |
| A-06 | 单个 `public/index.html` 承载所有前端应用 | 高维护性风险 | 四个独立构建入口与独立路由/资源 |
| A-07 | `server/app.js` 集中大量业务路由和 SQL | 高维护性风险 | 按领域模块拆分并保持 API 兼容 |
| A-08 | `db/schema.sql` 含多个 `DROP DATABASE` | 严重数据风险 | 生产只运行可回滚/可审计的增量 migration |
| A-09 | 部署脚本使用固定默认超管密码 | 高 | 首次启动强制设置一次性密码，不在日志输出秘密 |
| A-10 | README 的个人权限/角色权限描述与实现不一致 | 中高 | 统一为角色唯一授权源并同步文档/测试 |
| A-11 | API 路由权限规则使用多组正则表 | 中高 | 路由级声明式权限元数据，未声明默认拒绝 |
| A-12 | 前端直接依赖外部 CDN 全局脚本 | 中 | 依赖锁定、本地构建、CSP 与离线构建验证 |

## 8. 分阶段实施与验收门槛

### Phase 0 — 基线与审计
- 固定 main 基线与数据库 schema。
- 清点全部页面、API、表、角色、权限、静态资源和上传访问路径。
- 对照 README、代码、schema、测试，输出冲突清单。
- 不执行任何生产数据库重建，不覆盖生产环境配置。

### Phase 1 — 安全边界
- 修复未知 mode 回退、会话绑定校验、Token 摘要存储、过期/撤销、登录限流。
- 统一 RBAC 与企业级数据范围校验。
- 新增跨系统、跨租户、跨企业、超管访问业务 API 的负向测试。
- 先完成向后兼容迁移，再删除旧字段/逻辑。

### Phase 2 — 前端四入口
- 建立四个独立应用与四套登录/路由/layout。
- 先抽离 API client、无业务 UI、类型与校验工具。
- 按业务模块迁移页面，不通过复制整个旧 HTML 制造四份分叉代码。
- 每个应用单独 build、静态资源检查、路由和权限测试。

### Phase 3 — 后端模块化
- 拆 auth / organizations / rental / hotel / property / billing / monitoring / audit。
- 路由保持兼容，逐个模块迁移并执行 API contract tests。
- SQL 进入 Repository，事务进入 Service。

### Phase 4 — 数据库迁移与兼容
- 引入版本化 migrations、迁移锁、备份前置检查、失败回滚/恢复演练。
- 禁止部署过程运行破坏性 schema 初始化。
- 校验记录数、金额汇总、关联完整性和租户归属。

### Phase 5 — CI/CD 与切换
- CI：lint、unit、API integration、tenant isolation、security tests、四应用独立 build。
- 生成四个独立静态产物，支持按路径或独立域名部署。
- 灰度切换，保留旧入口兼容与回滚窗口。
- 全部验收通过后才合并 main；不得以文档提交或单元测试通过代替生产验收。

## 9. 必须通过的验收测试

1. rental token 访问 hotel/property/super API 均失败；反向同样成立。
2. 同一系统内 org A 无法读取/修改/删除 org B 数据。
3. company_admin 无法访问其他企业资源，不能调用主体级管理 API。
4. super 只能访问平台 API，任何业务 API 均返回 403。
5. 角色页面权限与操作权限即时生效，缺省拒绝。
6. session 过期、登出、撤销、密码重置后旧 Token 失效。
7. 四个应用可独立构建、部署、刷新深层路由，资源不互相加载。
8. 旧数据迁移前后记录数、金额汇总、关联关系一致。
9. 生产部署脚本不执行 DROP、不覆盖环境密钥、不重置现有数据库。
10. 回滚到旧版本后数据仍可读写，且无双写冲突。

## 10. 当前实施策略

先完成安全边界和四入口的最小可运行骨架，再迁移业务页面；不在一个提交中同时重写数据库、认证和全部业务。每一阶段单独提交、CI 验证并经 PR 审查。未经验证的阶段不合并 main。
