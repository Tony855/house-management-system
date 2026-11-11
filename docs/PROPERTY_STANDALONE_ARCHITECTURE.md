# 物业管理系统独立化：架构审计与重构方案

> 审计对象：`Tony855/house-management-system` 的 `main` 分支  
> 审计基线：2026-11-11  
> 本文是架构审计与迁移方案，不代表代码拆分、数据迁移或生产验证已经完成。

## 1. 结论

当前仓库不是独立物业系统，而是租房、酒店、物业三种业务共用一个 Express 应用的多租户产品。物业业务虽然使用独立的 `house_sys_property` 数据库，但仍依赖共享的 `house_sys` 用户、角色、会话、设置和全局配置；认证、权限、路由、前端入口、种子数据及部署入口均与另外两套系统耦合。

因此，不能只复制 `house_sys_property` 数据库或隐藏租房/酒店菜单。正确做法是提取物业产品边界，建立独立应用、独立认证、独立数据库、独立部署和独立 CI，同时保留物业内部多租户（管理处/物业主体）与企业客户隔离能力。

建议采用**模块化单体（Modular Monolith）**，暂不拆微服务。Node.js 20 + Express + MariaDB 可延续，避免无必要的技术栈迁移。

## 2. 当前结构与依赖

- 前端：单个 `public/index.html`，包含四种登录入口、超管控制台、租房/酒店/物业端和员工工作台。
- 后端：单个 `server/app.js` 承载认证、全部业务 API、租房合同、酒店订单、物业企业/投诉/宽带申请等。
- 数据访问：`server/db.js` 创建共享库 `house_sys` 和三个模式库；通过 AsyncLocalStorage 的 mode/orgId 决定业务库。
- 共享库：主体、用户、角色、设置、会话、全局配置、使用费配置等。
- 物业库：楼栋、房产/房间、企业客户、企业员工、抄表、宽带线路/变更/申请、账单、报修、投诉等。
- 上传：`uploads/org-<主体ID>/`，静态资源经会话校验后提供。
- 测试：有 API 集成测试、健康检查和前端脚本语法检查，但 package.json 未定义统一 test/lint/CI 命令。

## 3. 审计发现（按风险和确定性区分）

### A. 已确认的架构问题

1. **运行时强耦合**：物业启动时仍初始化并依赖三套模式连接池与共享库；`withMode(mode, orgId)` 是跨业务运行时上下文。
2. **单体入口混合业务**：`server/app.js` 同时包含三系统 FEATURES、ROUTE_FEATURE、路由权限矩阵和不同业务算法。物业不能独立发布或独立演进。
3. **前端产品混合**：单页同时承载多个产品入口和多套导航/页面逻辑，构建、回归和安全审查范围扩大。
4. **共享认证和权限模型**：物业账号与租房/酒店账号共用 users/roles/sessions；模式字段决定登录入口和系统归属。
5. **数据库初始化具破坏性**：`db/schema.sql` 使用 `DROP DATABASE IF EXISTS` 重建共享库及三个业务库。该脚本不应成为独立系统的日常升级/部署流程。
6. **文档与 Schema 不一致**：README 的共享库表数量、物业业务表数量在不同章节不一致；Schema 实际包含 usage_fee_config、usage_fee_payments、role_permissions、net_requests 等文档遗漏对象。必须以数据库实际 DDL 为准重新生成清单。
7. **测试命令不完整**：package.json 只有 start/seed，没有标准 test、lint、migration、build/check 脚本；现有测试依赖运行中的服务和预置数据库。
8. **默认凭据风险**：README 和 seed 包含公开演示账号/密码（例如 superadmin、物业管理员和员工默认密码）。必须确保仅在明确的 demo/dev 初始化中创建，生产初始化必须强制设置初始管理员凭据并要求首次改密。

### B. 必须进一步逐路由、逐 SQL 验证的高风险项（当前不能直接判定为已利用漏洞）

1. 所有业务查询是否在每条 SELECT/UPDATE/DELETE 中强制 `org_id`；关联查询是否同时校验关联记录属于同一 org。
2. 企业管理员 `company_id` 范围是否在 rooms、tenants、org-employees、bills、meters、net lines/changes/requests、repairs、complaints、统计、导出和文件读取的所有路径一致生效。
3. 企业管理员权限矩阵中，`GET` 默认放行的路由是否存在未覆盖的敏感只读接口；未知写路由是否 fail-closed。
4. `user_permissions` 与 `role_permissions` 的实际合并规则是否与 README “权限全部来自角色、员工不再有个人追加权限”一致。当前 Schema 仍保留个人权限表，README 不同章节也出现“角色权限 ∪ 个人权限”的旧描述。
5. 上传文件是否校验 MIME 与真实文件签名、图片解码、随机文件名、大小/像素限制、路径穿越、企业/主体归属及删除权限；仅校验扩展名或 data URL 不够。
6. 会话 token 是否使用足够强的随机数、是否支持撤销/轮换/并发登录策略；Cookie 是否设置 Secure、HttpOnly、SameSite、Path、过期时间；反向代理 HTTPS 部署配置是否正确。
7. 登录限流目前在应用进程内存 Map 中，需验证多进程/多实例部署下是否可绕过，并评估失败计数的清理、账号枚举与锁定拒绝服务风险。
8. 账单收款、部分付款、宽带申请审批执行、删除企业/主体等关键流程是否使用事务、幂等键、并发锁和审计事件；重复请求不得重复记账或重复执行。
9. 日期、金额、汇率、计费分段、时区边界和小数精度需要边界测试；金额必须使用 Decimal/整数最小货币单位，禁止 JS 浮点数作为最终财务真值。
10. 数据库是否存在必要外键、唯一约束、组合索引；org_id 过滤字段与 JOIN 字段需按真实查询计划优化。

## 4. 目标独立架构

```text
property-management/
  apps/
    api/                 # 独立 Express API，唯一业务入口
    web/                 # 物业管理后台/企业门户静态前端
    worker/              # 可选：提醒、账单任务、Webhook/outbox
  src/
    modules/
      identity/          # 用户、会话、密码、登录策略
      organizations/     # 物业管理主体与租户
      companies/         # 企业客户、企业员工、企业管理员
      properties/        # 小区/楼栋/房产/房间/业主关系
      billing/           # 物业费、水电费、账单、收款、退款/冲正
      utilities/         # 抄表、水电单价、计费
      network/           # 宽带线路、变更、申请、审批、计费
      maintenance/       # 报修、派工、处理记录
      complaints/        # 投诉建议、处理流程
      notices/           # 通知公告（新增模块）
      reports/           # 统计、对账、导出
      audit/             # 不可篡改审计事件
      files/             # 文件上传、访问授权
    shared/
      db/                # 单一 property 数据库连接与事务
      http/
      security/
      config/
  db/
    migrations/          # 只增量迁移，不 DROP 生产库
    seeds/
  deploy/
    Dockerfile
    compose.yaml
    nginx/
  docs/
  tests/
```

运行关系：

```text
物业 Web / 企业门户 / 员工移动端
             |
         HTTPS API
             |
    Property Modular Monolith
       |      |       |
    Modules  Auth   Audit/Jobs
             |
      property_management DB
             |
    private uploads / optional S3
```

### 独立系统内仍保留的业务隔离

- 平台管理员：只管理物业系统租户开通、平台级参数与运维监控，不默认拥有客户业务数据读取权。
- 物业主管理员：管理自己的物业主体、楼栋/房产、企业、账单、员工与角色。
- 物业员工：只访问角色授予的页面和操作。
- 企业管理员：仅访问所属企业的数据；宽带报装/加兆/减兆等申请经物业审批后执行。
- 每个业务实体强制绑定 `org_id`；企业范围资源再绑定 `company_id` 或 `owner_id`。授权必须在服务层集中校验，不依赖前端隐藏菜单。

## 5. 独立数据库建议

新系统使用单一数据库 `property_management`，按领域分表，不再需要 rental/hotel mode，也不依赖共享 `house_sys`。

建议核心表域：

- 平台/身份：`organizations`, `users`, `roles`, `role_permissions`, `sessions`, `password_reset_tokens`, `app_settings`
- 物业：`buildings`, `properties` 或 `units`, `companies`, `company_employees`, `ownerships`
- 计费：`fee_items`, `billing_periods`, `bills`, `bill_items`, `payments`, `payment_allocations`, `receipts`, `ledger_entries`
- 公用事业：`meters`, `meter_readings`, `utility_rates`
- 网络：`network_lines`, `network_changes`, `network_requests`
- 服务：`maintenance_tickets`, `ticket_assignments`, `complaints`, `notices`
- 平台治理：`audit_logs`, `file_objects`, `outbox_events`, `idempotency_keys`

不要求一次性重命名所有旧表。先建立映射和迁移脚本，优先保证历史数据完整、可回滚。

## 6. 分阶段实施计划

### Phase 0 — 审计与冻结边界
- 建立独立化分支；记录 main 基线与迁移决策。
- 列全量 API 路由、表、字段、SQL、前端页面、权限点、文件类型、环境变量。
- 绘制数据字典、ER 图、角色权限矩阵和业务流程。
- 标注所有 rental/hotel/shared 引用；形成零依赖验收清单。

### Phase 1 — 提取物业应用骨架
- 创建独立 Node 应用入口、配置模块、日志、错误处理中间件、健康检查。
- 仅连接物业独立数据库；移除 mode/FEATURES/ROUTE_FEATURE 多系统分支。
- 将物业路由迁入领域模块；统一组织上下文与事务边界。
- 保留旧 API 路径兼容层，避免前端一次性大改。

### Phase 2 — 身份与权限独立
- 迁移物业用户、角色、页面权限和操作权限。
- 建立组织级 RBAC + 企业数据范围授权（ABAC）。
- 默认拒绝未知 API；读写权限逐接口显式声明。
- 强制生产初始密码、密码策略、会话撤销、限流、CSRF/CORS/安全响应头策略。

### Phase 3 — 物业数据迁移
- 从 `house_sys` 中筛选 mode=property 的 org/users/roles/settings/sessions 相关数据。
- 从 `house_sys_property` 迁移全部业务表与关联记录。
- 保留原始 ID 或提供映射表；校验行数、金额合计、欠费余额、账单支付流水、附件引用。
- 新旧系统双读核对；切换前备份；迁移失败可回滚。

### Phase 4 — 前端与业务补全
- 独立物业登录、主管理员后台、员工工作台、企业门户。
- 保留现有房产、企业员工、账单、水电、宽带、报修、投诉功能。
- 完善通知公告、收费项目/账期、收款流水/退款冲正、电子收据、导入导出、对账等物业常用能力（先评估缺口，再实施）。
- 所有金额、时区、状态机和审批动作服务端统一实现。

### Phase 5 — 运维、部署与发布
- 独立 Dockerfile、Compose、健康检查、数据卷、上传卷、反向代理示例。
- 独立 .env.example、启动/升级/回滚/备份/恢复文档。
- 版本化数据库迁移，禁止生产启动自动 DROP/重建。
- 独立 CI：依赖审计、静态检查、单元测试、API 集成测试、迁移测试、权限矩阵测试、镜像构建。

### Phase 6 — 切换与验收
- staging 导入生产脱敏副本，执行完整迁移演练。
- 通过旧/新系统账单金额、支付流水、房产数量、企业数量和附件清单核对。
- 灰度只读 → 小范围写入 → 全量切换；保留旧系统只读窗口与回滚方案。
- 确认没有 rental/hotel 代码、数据库、账号或部署依赖后，才宣布完全独立。

## 7. 必须通过的验收标准

1. 新系统在全新服务器仅按自己的 README、Compose、数据库和环境变量即可启动。
2. 代码、依赖、容器、数据库、存储、认证、CI 均不需要原 house-management-system 的运行时服务。
3. 仓库中不存在 rental/hotel 模式、路由、页面和数据库连接；仅迁移工具可读取旧数据库。
4. 任意 org A 无法读取、修改、删除 org B 的任何记录；企业 A 无法访问企业 B 的资源、统计和附件。
5. 未授权接口默认 403/404；平台管理员不能绕过租户权限读取客户业务。
6. 账单、付款、审批、删除等关键操作具备事务、审计与幂等保护。
7. 全量迁移核对通过；备份恢复演练通过。
8. 单元/API/安全/迁移测试通过，CI 全绿；AMD64/ARM64 镜像均构建并启动成功。
9. 文档中的数据库表数、API、权限、环境变量与真实代码一致。

## 8. 发布策略与保护措施

- 不直接在 `main` 上重构；所有工作在独立分支，通过 PR 合并。
- 不在未完成备份和迁移演练前删除旧数据库或旧表。
- 不把旧版 `db/schema.sql` 的 DROP 逻辑带入生产迁移流程。
- 不将演示密码写入生产镜像或生产 seed。
- 不宣称“已独立”直到上述验收全部通过。
