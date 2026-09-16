# 房屋管理系统（租房 · 酒店 · 物业，多租户 SaaS）

基于 **Node.js + Express + MariaDB** 的房屋经营管理系统。对外是三套独立系统
（租房 / 酒店 / 物业），对内是**多租户**架构：超级管理员开通的每一个「主管理员」
就是一个**经营主体（租户 org）**，同一系统内可有多个主体，彼此的业务数据、
系统设置（币种/汇率/单价）、角色与员工**完全独立、互不可见**。

## 角色与职责

| 角色 | 入口 | 职责 |
|---|---|---|
| **超级管理员** `super` | 超级管理员入口 | 仅两件事：**① 开通/编辑/删除主管理员（经营主体）；② 系统监控**。不参与任何业务，不配置角色权限，不设置单价/汇率；后端业务接口对其一律 403 |
| **主管理员** `admin` | 所属系统入口（租房/酒店/物业） | 一个主管理员 = 一个经营主体，拥有本主体全部业务功能；并可在本主体内**自建员工角色、配置角色页面与操作权限、增删员工、设置本主体币种/汇率/单价** |
| **员工** `staff` | **所属系统入口**（租房/酒店/物业，与主管理员共用本系统窗口） | 独立员工工作台，仅能访问角色授予的页面，且仅能操作角色授予的操作权限（如新增/编辑/删除/收款），无任何管理功能 |
| **企业管理员** `company_admin` | 物业系统入口 | **仅物业**：主管理员在「企业管理」页为某企业设置的账号（每企业 1 个），登录后仅见本企业数据（房产/企业员工/账单/抄表/网络/报修/投诉/仪表盘统计），**只读**；唯一写权限为在「网络管理」提交宽带**报装 / 加兆 / 减兆上报申请**（主管理员审批后执行）。删除企业时账号级联清理 |

- 系统内置角色 `super / admin / staff`（`org_id = NULL`，不可删）；主管理员自建的
  角色固定为**员工层级**，仅在本主体内可见、可用。
- **角色权限（页面访问 + 操作两级）**：主管理员在「角色管理」为自建角色分别配置
  **页面访问权限**（能进哪些页面）与**操作权限**（该页面的新增/编辑/删除/收款等按钮）；
  分配该角色的员工自动获得这两级权限（**权限全部来自角色，员工不再有个人追加权限**，
  改角色权限即时生效）；内置 `staff` 角色不可配置权限。三个系统的角色、员工与权限完全隔离。
- 密码 scrypt 加盐哈希；登录基于服务端 token 会话表。

## 四个独立登录入口（三系统独立运营，账号与入口强绑定）

登录首页按「**租房 / 酒店 / 物业 / 超级管理员**」四个入口分别登录：

- **三个系统独立运营**：租房 / 酒店 / 物业各有自己的登录窗口，本系统的**主管理员与
  员工均从本系统窗口登录**（窗口内按账号角色自动进入主管理员端或员工工作台）；
- 超管只能走超级管理员入口；账号与窗口系统不匹配时统一返回「用户名或密码错误」，
  **不泄露账号归属哪个系统**；
- 登录后固定所属系统与主体，**无系统切换器**；三个系统间的员工账号、权限、角色、
  设置与业务数据全部按主体独立隔离。
- 默认记账/显示币种为**美元（USD）**，默认汇率 1 USD = 7.2 CNY（各主体可自行修改）。

## 全局配置（超管「系统设置」）

- 超管控制台 →「系统设置」可配置两项全局开关（存 `app_config` 表，超管级，与经营主体无关）：
  - **隐藏登录入口选择**：开启后打开系统网址不再显示四个登录入口卡片，直接进入
    「隐藏后默认登录入口」指定的登录窗口（默认租房）；登录页同时隐藏「返回选择登录入口」链接，
    站点呈现为纯净的单一系统登录页；入口地址仍可地址直达（`#login-xxx`）；
  - **隐藏后默认登录入口**：租房 / 酒店 / 物业 / 超级管理员；
- 该配置为「域名绑定系统」预留扩展位：后续可按域名自动选择默认入口，覆盖此默认值。
- `GET /api/app-config` 公开读取（登录页需要）；`PUT /api/app-config` 仅超管可写。

## 三系统功能裁剪（物理隔离，用不到的表/接口/菜单直接移除）

| 功能 | 租房 rental | 酒店 hotel | 物业 property |
|---|:-:|:-:|:-:|
| 楼栋 / 房间 | ✅ | ✅ | ✅ |
| 租客·房客·业主 | 租客 | 房客 | 业主 |
| 合同（新签/编辑/终止/到期） | ✅ | — | — |
| 订单（预订/入住/退房自动出账） | — | ✅ | — |
| **水电抄表** | ✅ | — | ✅ |
| **网络管理 / 网费账单** | ✅ | — | ✅ |
| 租金 / 房费 / 物业费账单 | 租金 | 房费 | 物业费 |
| 报修 | ✅ | ✅ | ✅ |
| 投诉建议 | — | — | ✅ |
| 系统设置项 | 币种·汇率·网费·水价·电价 | **仅币种·汇率** | 币种·汇率·网费·水价·电价 |
| 业务表数量 | 8 | 6 | 8 |

不属于某系统的接口直接返回 `404 当前系统不提供该功能`，前端导航也不显示对应页面。

## 主要业务能力

- **仪表盘**：房间统计、入住率、本月应收/已收、累计欠费、待处理报修、到期合同、
  今日入住/退房/在住押金、最近账单等（按系统能力分支，缺省指标为 0）。
- **楼栋 / 房间**：增删改查、筛选、删除保护；房间可单独设置租金/日价、押金、带宽、
  每兆月租、水电单价（新增时自动带入本主体设置默认值，已建房间不受影响）。
- **租客 / 房客 / 业主**：增删改查与删除保护（有在租合同、在住订单或名下房产不可删）。
- **账单收费**：手动添加、一键生成（租金/房费/物业费、水电、网费）、收款（支持部分
  支付）、按来源与状态筛选；网络管理页可对单房生成/删除网费账单。
- **水电抄表**：每月每房一条，用量 = max(0, 本期 − 上期)，费用 = 用量 × 房间单价。
- **网络管理**：一个房间可开通多条宽带线路（线路名称/带宽/开通日/备注），支持加兆/
  减兆（按线路）、停用（停用日按天折算、历史保留、可重新启用）；网费 = 各启用线路
  费用之和，每条按「带宽 × 每兆月租 × 段天数 ÷ 当月天数」分段累加，单价统一取本
  经营主体「系统设置」；提供预估与满月对比、按线路分段明细与变更历史。
- **宽带申请（上报）**：企业管理员在「网络管理」提交**报装 / 加兆 / 减兆**申请
  （仅限本企业房产，报装填目标带宽、加/减兆填增减数值并选择线路）；主管理员审批，
  **通过即自动执行**（报装=创建启用线路，加/减兆=写入带宽变更并更新线路带宽），
  或驳回并填写原因；申请单全程可查。
- **报修 / 投诉**：登记与处理流转（待处理 → 处理中 → 已完成/已办结）。
- **系统监控（超管）**：聚合三系统核心指标 + 每个系统下各经营主体的房间/出租/应收/
  欠费/待办/员工明细，只读。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML/CSS/JS + Bootstrap 5（静态文件，无构建） |
| 后端 | Node.js 20 + Express 4 |
| 数据库 | MariaDB（mysql2/promise 连接池，utf8mb4） |
| 认证 | 服务端 token 会话表 + scrypt 加盐哈希 |
| 多租户隔离 | 所有业务表带 `org_id` 行级归属；会话经 AsyncLocalStorage 注入 `mode/orgId` |

## 目录结构

```
Property/
├── db/
│   ├── schema.sql        # 建库建表脚本（先 DROP 再 CREATE，1 共享库 + 3 系统库）
│   ├── init.sh           # 一键初始化（默认 core 干净；bash db/init.sh demo 写演示数据）
│   ├── test_api.js       # 多租户 API 端到端测试（46 项断言，自动开通并清理临时主体）
│   ├── verify.sh         # 健康检查（登录/隔离/能力裁剪/权限边界）
│   └── check_frontend.js # 前端内联 JS 语法校验
├── server/
│   ├── app.js            # Express 服务与全部 API 路由（FEATURES 能力矩阵 + org 隔离 + 网费算法）
│   ├── db.js             # 多库连接池；withMode(mode, orgId, fn) 基于 ALS 注入当前系统/主体
│   ├── seed.js           # 种子：node seed.js core（仅账号）/ node seed.js（含演示业务）
│   └── util.js           # 密码哈希 / 日期工具
├── public/
│   └── index.html        # 前端单页（四个登录入口 + 超管控制台 + 三套系统端 + 员工工作台）
├── package.json
└── README.md
```

## 快速开始（Debian 13 / WSL，MariaDB root 空密码）

```bash
cd /path/to/Property

# 1. 初始化（默认仅账号体系、业务为空；想看演示数据用 bash db/init.sh demo）
bash db/init.sh

# 2. 启动服务
npm start            # 访问 http://localhost:16088
```

- 默认端口 **16088**，可用环境变量 `PORT` 覆盖；数据库连接可用
  `DB_HOST / DB_PORT / DB_USER / DB_PASSWORD` 覆盖（默认 127.0.0.1:3306、root、空密码）。
- **重建库前先停掉正在运行的 node 服务**，否则其连接池会阻塞 `DROP DATABASE`。
- 首次安装默认超管账号：**`superadmin / super123`**。
- core 种子内置账号（业务数据为空）：

| 账号 | 密码 | 身份 | 入口 |
|---|---|---|---|
| `superadmin` | `super123` | 超级管理员 | 超级管理员入口 |
| `admin_r` | `admin_r123` | 租房主管理员（默认主体：租房） | 租房入口 |
| `admin_h` | `admin_h123` | 酒店主管理员（默认主体：酒店） | 酒店入口 |
| `admin_p` | `admin_p123` | 物业主管理员（默认主体：物业） | 物业入口 |
| `staff` | `staff123` | 租房员工 | 租房入口 |
| `wy` | `wy123` | 物业员工 | 物业入口 |

> 正式使用：用超管登录 → 主管理员管理 → 为每个客户「开通主管理员（经营主体）」，
> 把生成的系统入口账号交给客户；客户登录后自行维护业务、员工、角色与本主体设置。

## 常用命令

```bash
npm start                 # 启动服务
bash db/init.sh           # 重建库表 + core 干净种子（业务为空）
bash db/init.sh demo      # 重建库表 + 三系统演示业务数据
node server/seed.js core  # 仅补账号体系（库已有账号时跳过）
node server/seed.js       # 补账号 + 演示业务（库已有账号时跳过）
node db/test_api.js       # 多租户 API 端到端测试（需服务已启动，自动清理临时数据）
bash db/verify.sh         # 健康检查（需服务已启动）
node db/check_frontend.js # 前端 JS 语法校验
```

## 数据库（1 个共享库 + 3 个系统库）

**共享库 `house_sys`（6 张表）**

| 表 | 说明 |
|---|---|
| `orgs` | 经营主体（租户）：`id / name / mode(rental/hotel/property) / admin_user_id` |
| `users` | 用户：`(org_id, username)` 联合唯一（同系统内账号名唯一、跨系统可重名）/ password / real_name / role(角色编码) / mode / org_id(归属主体，超管为 NULL) |
| `roles` | 角色：内置角色 `org_id=NULL`；主体自建角色 `org_id=<主体>`，唯一键 `(org_id, code)`，`level=super/admin/staff` |
| `settings` | **每个主体一行**（`org_id` 主键）：`currency / rate / net_price_per_mb / water_price / elec_price`，内部以人民币存储 |
| `app_config` | 全局配置（超管级）：`login_selector(show/hide)` / `login_default(rental/hotel/property/super)` |
| `sessions` | 登录会话：`token / user_id / mode / org_id` |
| `user_permissions` | 员工**个人**页面权限：`(user_id, page)` 唯一 |
| `role_permissions` | **角色**页面权限：`(role_id, page)` 唯一；**员工实际权限 = 角色权限 ∪ 个人权限**（按主体隔离，改角色权限即时生效） |

**系统库（业务表均带 `org_id` 行级归属）**

- `house_sys_rental`（9 表）：buildings, rooms, tenants, **contracts**, **meters**,
  **room_net_lines**, **net_changes**, bills, repairs；rooms 含租金/押金/水电单价
  （带宽/网费单价/开通日已迁至线路表）；bills.source ∈ `rental / utility / network`。
- `house_sys_hotel`（6 表）：buildings, rooms, tenants, **orders**, bills, repairs；
  rooms 仅日价/押金，无网络/水电/合同字段；bills.source = `hotel`；设置仅币种/汇率。
- `house_sys_property`（10 表）：buildings, rooms, tenants, meters, room_net_lines,
  net_changes, bills, repairs, complaints, **org_employees**；rooms 含企业/物业费/水电单价；
  **tenants = 企业客户（企业化模式，无个人业主）**，`org_employees` 为企业名下员工档案
  （本人照片/证件照可上传至 `uploads/org-<主体ID>/`）；bills.source ∈ `property / network`。

## 多租户隔离机制

- 每个业务请求经会话解析出 `mode` 与 `orgId`，由 `withMode(mode, orgId, fn)`
  （AsyncLocalStorage）注入当前连接上下文；所有业务 SQL 的 SELECT 带 `org_id` 条件、
  INSERT 带 `org_id` 列，从行级保证主体间互不可见、互不覆盖。
- **企业管理员（物业）第二层隔离**：`users.company_id` 标记企业管理员；后端在
  rooms/tenants/org-employees/bills/meters/netLines/netChanges/repairs/complaints
  及 `/api/stats` 全部注入 `owner_id = company_id`（或经 rooms JOIN）条件，前端导航
  裁剪为 8 个数据页并隐藏全部写按钮；写接口（含设置/账号管理）统一 403。
- 超管开通主体（`POST /api/orgs`）在一个事务内：建 org → 建该主体 admin 用户 →
  建该主体 settings 默认行 → 回填 `admin_user_id`。
- 删除主体（`DELETE /api/orgs/:id`）级联清空该主体在系统库的全部业务数据，以及共享库
  中的员工、权限、会话、设置、自建角色、主体与主管理员账号（不可恢复，前端二次确认）。
- 系统能力由后端 `FEATURES` 矩阵 + `ROUTE_FEATURE` 中间件统一裁剪，前端导航同源裁剪，
  避免出现「菜单隐藏但接口可用」。

## 主要 HTTP 接口（统一前缀 /api，需 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /login | 登录（body.mode：super / rental / hotel / property）；账号必须从所属窗口登录，不匹配返回通用「用户名或密码错误」 |
| GET / POST | /me / /logout | 当前用户 / 退出 |
| GET / POST / PUT / DELETE | /orgs · /orgs/:id | **仅超管**：列出/开通/编辑（改名、重置密码）/级联删除经营主体 |
| GET | /monitor | **仅超管**：三系统聚合指标 + 每系统主体明细 |
| GET / PUT | /settings | 读取/修改**本主体**币种、汇率、（租房/物业）网费与水电单价；酒店仅币种汇率；PUT 需主管理员 |
| GET | /app-config | 全局配置（公开读取：登录入口选择开关 / 默认入口） |
| PUT | /app-config | 修改全局配置（仅超管） |
| GET/POST/PUT/DELETE | /roles · /roles/:id | 主管理员管理本主体员工级角色（内置 staff 只读）；超管管内置角色 |
| GET/POST/PUT/DELETE | /users · /users/:id | **仅主管理员**：本主体员工增删改与页面权限（看不到主管理员与其他主体） |
| GET | /stats | 本主体仪表盘统计（按系统能力分支） |
| GET/POST · PUT/DELETE | /buildings · /buildings/:id | 楼栋 |
| GET/POST · PUT/DELETE | /rooms · /rooms/:id | 房间/房产 |
| GET/POST · PUT/DELETE | /tenants · /tenants/:id | 租客/房客/**企业**（物业=企业客户，删除前校验名下房产/企业员工） |
| GET/POST · PUT/DELETE | /org-employees · /org-employees/:id | **仅物业**：企业员工档案（读需 orgemp 权限或主管理员，写仅主管理员；company 自动匹配/创建企业） |
| POST | /tenants/:id/company-admin | **仅物业主管理员**：设置/重置企业管理员账号（username/real_name/password；重复设置=重置密码） |
| POST | /upload | **仅物业主管理员**：base64 图片上传（jpeg/png/webp ≤2MB），返回 `/uploads/...` URL |
| GET/POST · PUT · /terminate | /contracts | 租房合同（仅 rental） |
| GET/POST · PUT/DELETE · /checkin · /checkout · /cancel | /orders | 酒店订单（仅 hotel） |
| GET/POST · /generate · /:id/pay · DELETE | /bills | 账单；generate 的 kind=all/rental/hotel/property/utility/network |
| GET/POST · PUT/DELETE | /meters | 水电抄表（rental / property） |
| GET/POST · DELETE | /netChanges | 带宽变更（rental / property，按线路） |
| GET/POST · PUT · /:id/stop · /:id/start | /netLines | 宽带线路增删改/停用/重新启用（rental / property） |
| GET | /netfee | 网费预估（按线路分段明细 + 满月对比） |
| GET/POST · PUT/DELETE | /repairs | 报修 |
| GET/POST · PUT/DELETE | /complaints | 投诉建议（仅 property） |

> 越权与裁剪统一返回：未登录 401、跨级越权 403、当前系统不具备该功能 404。

## 计费与币种说明

- 金额内部统一以 **CNY 存储**，USD 仅作显示换算（显示 = 人民币 ÷ 汇率，录入 = 外币 ×
  汇率折回人民币）；默认显示 USD，汇率按主体独立配置。
- 网费：线路表 `room_net_lines` 存开通/停用与当前带宽，`net_changes` 按线路记录
  加兆/减兆变更；`getLineBandwidthAt` 回滚该日之后的变更得到任意日期带宽，
  `calcLineFee` 在生效区间（开通~停用）内按变更分段，每段「带宽 × 每兆月租 ×
  段天数（含首尾）÷ 当月天数」累加；房间网费 = 各线路费用之和；单价统一取本主体
  设置 `net_price_per_mb`（线路表不存单价）。
- 水电：用量 × **房间单价**；房间单价在新增时取本主体设置默认值，之后互不影响。
- 房间状态由业务动作流转：新签合同 / 业主绑定 → 已出租（计费）；酒店退房 → 待清洁 →
  清洁完成 → 空置。
