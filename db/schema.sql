-- ==================================================================
-- 房屋管理系统 · 数据库结构（多租户 + 三系统差异化）
-- 共享库 house_sys：orgs(经营主体) / users / roles / settings / sessions / user_permissions
-- 模式库：house_sys_rental(租房) / house_sys_hotel(酒店) / house_sys_property(物业)
--   - 同一系统下可有多个经营主体（主管理员），业务数据按 org_id 行级隔离
--   - 各系统只建本系统用到的表与房间字段（物理裁剪）
-- 重建：mysql -uroot < db/schema.sql
-- ==================================================================

DROP DATABASE IF EXISTS house_sys;
CREATE DATABASE house_sys CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE house_sys;

-- ---------- 经营主体（一个主管理员 = 一个经营主体 = 一个租户） ----------
CREATE TABLE orgs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,                  -- 经营主体名称（如：金边1号公寓）
  mode          ENUM('rental','hotel','property') NOT NULL,
  admin_user_id INT NULL,                               -- 主管理员用户 id
  fee_start     DATE NULL,                              -- 使用费计费开始日
  fee_due       DATE NULL,                              -- 当前到期日（NULL=不限制）
  fee_cycle     ENUM('month','year','once') NOT NULL DEFAULT 'month',
  fee_price     DECIMAL(10,2) NOT NULL DEFAULT 0,       -- 该主体单价（0=按系统默认）
  fee_status    ENUM('active','paused','closed') NOT NULL DEFAULT 'active', -- 缴费状态
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------- 使用费全局配置（单行 id=1，超管级） ----------
CREATE TABLE usage_fee_config (
  id             INT PRIMARY KEY,
  fee_mode       ENUM('free','paid') NOT NULL DEFAULT 'free', -- 收费模式
  cycle          ENUM('month','year','once') NOT NULL DEFAULT 'month', -- 默认周期
  remind_days    INT NOT NULL DEFAULT 7,                 -- 到期前提前提醒天数
  session_days   INT NOT NULL DEFAULT 7,                 -- 登录会话有效期（天）
  rental_price   DECIMAL(10,2) NOT NULL DEFAULT 0,       -- 租房月单价
  hotel_price    DECIMAL(10,2) NOT NULL DEFAULT 0,       -- 酒店月单价
  property_price DECIMAL(10,2) NOT NULL DEFAULT 0,       -- 物业月单价
  currency       ENUM('USD','CNY') NOT NULL DEFAULT 'USD',
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------- 使用费收款流水（超管登记） ----------
CREATE TABLE usage_fee_payments (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  pay_date   DATE NOT NULL,
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  operator   VARCHAR(50) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fee_pay_org (org_id)
) ENGINE=InnoDB;

-- ---------- 角色：org_id 为 NULL 表示系统内置角色；非空为某主体自建角色 ----------
CREATE TABLE roles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NULL,
  code        VARCHAR(30) NOT NULL,
  name        VARCHAR(50) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  level       ENUM('super','admin','staff','manager') NOT NULL DEFAULT 'staff',
  is_system   TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_org_code (org_id, code)
) ENGINE=InnoDB;

-- ---------- 用户：超管 org_id/mode 为 NULL；主管理员/员工绑定主体 ----------
CREATE TABLE users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(50)  NOT NULL,
  password   VARCHAR(255) NOT NULL,
  real_name  VARCHAR(50)  NOT NULL DEFAULT '',
  role       VARCHAR(30)  NOT NULL DEFAULT 'staff',
  mode       ENUM('rental','hotel','property') NULL,
  org_id     INT NULL,
  company_id INT NULL,   -- 企业管理员：非空 = 物业系统某企业（tenants.id），仅本企业数据可见
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_org (org_id),
  UNIQUE KEY uk_org_username (org_id, username)
) ENGINE=InnoDB;

-- ---------- 系统设置：每个经营主体一行（汇率/币种/单价各自独立） ----------
CREATE TABLE settings (
  org_id           INT PRIMARY KEY,
  currency         ENUM('CNY','USD') NOT NULL DEFAULT 'USD',
  rate             DECIMAL(10,4) NOT NULL DEFAULT 7.2000,  -- 1 美元 = ? 人民币
  net_price_per_mb DECIMAL(10,2) NOT NULL DEFAULT 1.00,    -- 网费单价（元/兆/月）
  water_price      DECIMAL(10,2) NOT NULL DEFAULT 4.50,    -- 水价（元/吨）
  elec_price       DECIMAL(10,2) NOT NULL DEFAULT 1.00,    -- 电价（元/度）
  item_lib         LONGTEXT NULL,                           -- 常用商品库 JSON：[{name,model,price,cat}]
  remind_enable    TINYINT NOT NULL DEFAULT 1,              -- 账单到期提醒开关
  remind_days      INT NOT NULL DEFAULT 3                   -- 提前提醒天数（0=仅逾期）
) ENGINE=InnoDB;

-- ---------- 登录会话 ----------
CREATE TABLE sessions (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    INT NOT NULL,
  mode       ENUM('rental','hotel','property') NOT NULL DEFAULT 'rental',
  org_id     INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sessions_user (user_id)
) ENGINE=InnoDB;

-- ---------- 员工页面权限 ----------
CREATE TABLE user_permissions (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  page    VARCHAR(30) NOT NULL,
  UNIQUE KEY uk_user_page (user_id, page)
) ENGINE=InnoDB;

-- ---------- 全局配置（超管级，与经营主体无关；预留域名绑定系统等后续扩展） ----------
CREATE TABLE app_config (
  k          VARCHAR(50) PRIMARY KEY,
  v          VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------- 角色页面权限（主管理员为自建角色配置；员工实际权限 = 角色权限 ∪ 个人权限） ----------
CREATE TABLE role_permissions (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT NOT NULL,
  org_id  INT NOT NULL DEFAULT 0 COMMENT '0=全局默认模板；>0=该经营主体覆盖配置',
  page    VARCHAR(30) NOT NULL,
  UNIQUE KEY uk_role_page_org (role_id, page, org_id)
) ENGINE=InnoDB;

-- ==================================================================
-- 租房系统 house_sys_rental
--   楼栋 / 房间(月租·押金·水电单价·带宽) / 租客 / 合同 / 水电抄表 / 带宽变更 / 账单 / 报修
-- ==================================================================
DROP DATABASE IF EXISTS house_sys_rental;
CREATE DATABASE house_sys_rental CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE house_sys_rental;

CREATE TABLE buildings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  name       VARCHAR(50) NOT NULL,
  address    VARCHAR(200) NOT NULL DEFAULT '',
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE rooms (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  org_id           INT NOT NULL,
  building_id      INT NOT NULL,
  room_no          VARCHAR(20) NOT NULL,
  floor            DECIMAL(5,1) NULL,
  area             DECIMAL(8,2) NULL,
  rent             DECIMAL(10,2) NOT NULL DEFAULT 0,   -- 月租金
  deposit          DECIMAL(10,2) NOT NULL DEFAULT 0,   -- 押金
  status           ENUM('vacant','rented','maintenance') NOT NULL DEFAULT 'vacant',
  room_type        VARCHAR(50) NOT NULL DEFAULT '',
  is_dorm          TINYINT NOT NULL DEFAULT 0,     -- 标记为宿舍（物业）
  capacity         INT NOT NULL DEFAULT 0,          -- 宿舍容量（0=不限制）
  water_price      DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_price       DECIMAL(10,2) NOT NULL DEFAULT 0,
  remark           VARCHAR(200) NOT NULL DEFAULT '',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_rooms_building (building_id)
) ENGINE=InnoDB;

CREATE TABLE tenants (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  name       VARCHAR(50) NOT NULL,
  gender     ENUM('男','女') NOT NULL DEFAULT '男',
  phone      VARCHAR(20) NOT NULL DEFAULT '',
  id_card    VARCHAR(30) NOT NULL DEFAULT '',
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE contracts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  contract_no VARCHAR(50) NOT NULL,
  room_id     INT NOT NULL,
  tenant_id   INT NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  rent        DECIMAL(10,2) NOT NULL DEFAULT 0,
  deposit     DECIMAL(10,2) NOT NULL DEFAULT 0,
  pay_cycle   INT NOT NULL DEFAULT 1,
  sign_date   DATE NOT NULL,
  status      ENUM('active','expired','terminated') NOT NULL DEFAULT 'active',
  remark      VARCHAR(200) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_contracts_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE meters (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  room_id     INT NOT NULL,
  month       CHAR(7) NOT NULL,
  water_prev  DECIMAL(10,2) NOT NULL DEFAULT 0,
  water_curr  DECIMAL(10,2) NOT NULL DEFAULT 0,
  water_usage DECIMAL(10,2) NOT NULL DEFAULT 0,
  water_fee   DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_prev   DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_curr   DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_usage  DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_fee    DECIMAL(10,2) NOT NULL DEFAULT 0,
  remark      VARCHAR(200) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_room_month (room_id, month),
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

-- 房间宽带线路：一个房间可开通多条独立宽带，单价统一取经营主体设置
CREATE TABLE room_net_lines (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  room_id    INT NOT NULL,
  line_name  VARCHAR(50) NOT NULL DEFAULT '默认线路',
  bandwidth  INT NOT NULL DEFAULT 0,           -- 当前带宽（兆）
  start_date DATE NULL,                        -- 开通日
  status     ENUM('active','stopped') NOT NULL DEFAULT 'active',
  stop_date  DATE NULL,                        -- 停用日（停用后不再计费）
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_net_lines_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE net_changes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  org_id        INT NOT NULL,
  room_id       INT NOT NULL,
  line_id       INT NULL,                      -- 归属线路
  change_date   DATE NOT NULL,
  change_type   ENUM('add','reduce') NOT NULL DEFAULT 'add',
  old_bandwidth INT NOT NULL DEFAULT 0,
  new_bandwidth INT NOT NULL DEFAULT 0,
  remark        VARCHAR(200) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_net_changes_room (room_id)
) ENGINE=InnoDB;

/* 宽带报装 / 加兆 / 减兆 上报申请（企业管理员提交，主管理员审批并执行） */
CREATE TABLE net_requests (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  org_id        INT NOT NULL,
  company_id    INT NULL,                      -- 提交企业（企业管理员）
  room_id       INT NOT NULL,                  -- 申请房间
  type          ENUM('install','add','reduce') NOT NULL DEFAULT 'install',  -- 报装/加兆/减兆
  bandwidth     INT NULL,                      -- 报装：目标带宽（兆）
  delta         INT NULL,                      -- 加/减兆：增减数值（兆）
  line_id       INT NULL,                      -- 加/减兆：目标线路（报装为空）
  reason        VARCHAR(500) NOT NULL DEFAULT '',
  status        ENUM('pending','done','rejected') NOT NULL DEFAULT 'pending',
  created_by    VARCHAR(64) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_by    VARCHAR(64) NOT NULL DEFAULT '',
  handle_note   VARCHAR(500) NOT NULL DEFAULT '',
  handled_at    DATETIME NULL,
  INDEX idx_org (org_id), INDEX idx_net_req_company (company_id), INDEX idx_net_req_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE bills (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  org_id       INT NOT NULL,
  source       ENUM('rental','utility','network','net_repair','install','repair','other') NOT NULL DEFAULT 'rental',
  room_id      INT NOT NULL,
  tenant_id    INT NULL,
  contract_id  INT NULL,
  order_id     INT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  due_date     DATE NOT NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  status       ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
  pay_method   VARCHAR(20) NOT NULL DEFAULT '',
  pay_date     DATE NULL,
  remark       VARCHAR(500) NOT NULL DEFAULT '',
  items        JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_bills_room (room_id)
 ) ENGINE=InnoDB;

CREATE TABLE bill_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  transaction_type ENUM('receipt','refund') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bill_transactions_request (request_id),
  KEY idx_bill_transactions_bill_date (bill_id, transaction_date, id),
  CONSTRAINT chk_bill_transactions_amount CHECK (amount > 0),
  CONSTRAINT fk_bill_transactions_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT
 ) ENGINE=InnoDB;

CREATE TABLE bill_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  transaction_type ENUM('receipt','refund') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bill_transactions_request (request_id),
  KEY idx_bill_transactions_bill_date (bill_id, transaction_date, id),
  CONSTRAINT chk_bill_transactions_amount CHECK (amount > 0),
  CONSTRAINT fk_bill_transactions_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE repairs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  room_id     INT NOT NULL,
  title       VARCHAR(100) NOT NULL,
  content     VARCHAR(500) NOT NULL DEFAULT '',
  status      ENUM('pending','processing','done') NOT NULL DEFAULT 'pending',
  handler     VARCHAR(50) NOT NULL DEFAULT '',
  handle_note VARCHAR(500) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

-- ==================================================================
-- 酒店系统 house_sys_hotel
--   楼栋 / 房间(日价·押金) / 房客 / 订单 / 账单 / 报修
-- ==================================================================
DROP DATABASE IF EXISTS house_sys_hotel;
CREATE DATABASE house_sys_hotel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE house_sys_hotel;

CREATE TABLE buildings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  name       VARCHAR(50) NOT NULL,
  address    VARCHAR(200) NOT NULL DEFAULT '',
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE rooms (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  building_id INT NOT NULL,
  room_no    VARCHAR(20) NOT NULL,
  floor      DECIMAL(5,1) NULL,
  area       DECIMAL(8,2) NULL,
  day_price  DECIMAL(10,2) NOT NULL DEFAULT 0,   -- 日房价
  deposit    DECIMAL(10,2) NOT NULL DEFAULT 0,
  status     ENUM('vacant','rented','booked','cleaning','maintenance') NOT NULL DEFAULT 'vacant',
  room_type  VARCHAR(50) NOT NULL DEFAULT '',
  is_dorm    TINYINT NOT NULL DEFAULT 0,
  capacity   INT NOT NULL DEFAULT 0,
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_rooms_building (building_id)
) ENGINE=InnoDB;

CREATE TABLE tenants (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  name       VARCHAR(50) NOT NULL,
  gender     ENUM('男','女') NOT NULL DEFAULT '男',
  phone      VARCHAR(20) NOT NULL DEFAULT '',
  id_card    VARCHAR(30) NOT NULL DEFAULT '',
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  org_id         INT NOT NULL,
  order_no       VARCHAR(50) NOT NULL,
  room_id        INT NOT NULL,
  guest_id       INT NOT NULL,
  check_in_date  DATE NOT NULL,
  check_out_date DATE NOT NULL,
  days           INT NOT NULL DEFAULT 0,
  day_price      DECIMAL(10,2) NOT NULL DEFAULT 0,
  total          DECIMAL(10,2) NOT NULL DEFAULT 0,
  deposit        DECIMAL(10,2) NOT NULL DEFAULT 0,
  status         ENUM('booked','checked_in','checked_out','cancelled') NOT NULL DEFAULT 'booked',
  checkin_time   DATETIME NULL,
  checkout_time  DATETIME NULL,
  remark         VARCHAR(200) NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_orders_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE bills (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  org_id       INT NOT NULL,
  source       ENUM('hotel') NOT NULL DEFAULT 'hotel',
  room_id      INT NOT NULL,
  tenant_id    INT NULL,
  contract_id  INT NULL,
  order_id     INT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  due_date     DATE NOT NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  status       ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
  pay_method   VARCHAR(20) NOT NULL DEFAULT '',
  pay_date     DATE NULL,
  remark       VARCHAR(500) NOT NULL DEFAULT '',
  items        JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_bills_room (room_id)
 ) ENGINE=InnoDB;

CREATE TABLE bill_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  transaction_type ENUM('receipt','refund') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bill_transactions_request (request_id),
  KEY idx_bill_transactions_bill_date (bill_id, transaction_date, id),
  CONSTRAINT chk_bill_transactions_amount CHECK (amount > 0),
  CONSTRAINT fk_bill_transactions_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE repairs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  room_id     INT NOT NULL,
  title       VARCHAR(100) NOT NULL,
  content     VARCHAR(500) NOT NULL DEFAULT '',
  status      ENUM('pending','processing','done') NOT NULL DEFAULT 'pending',
  handler     VARCHAR(50) NOT NULL DEFAULT '',
  handle_note VARCHAR(500) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

-- ==================================================================
-- 物业系统 house_sys_property
--   楼栋 / 房产(业主·物业费·水电单价·带宽) / 业主 / 水电抄表 / 带宽变更 / 账单 / 报修 / 投诉
-- ==================================================================
DROP DATABASE IF EXISTS house_sys_property;
CREATE DATABASE house_sys_property CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE house_sys_property;

CREATE TABLE buildings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  name       VARCHAR(50) NOT NULL,
  address    VARCHAR(200) NOT NULL DEFAULT '',
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE rooms (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  org_id           INT NOT NULL,
  building_id      INT NOT NULL,
  room_no          VARCHAR(20) NOT NULL,
  floor            DECIMAL(5,1) NULL,
  area             DECIMAL(8,2) NULL,
  status           ENUM('vacant','rented','maintenance') NOT NULL DEFAULT 'vacant',
  room_type        VARCHAR(50) NOT NULL DEFAULT '',
  owner_id         INT NULL,
  property_fee     DECIMAL(10,2) NOT NULL DEFAULT 0,  -- 物业费/月
  is_dorm          TINYINT NOT NULL DEFAULT 0,         -- 标记为宿舍
  capacity         INT NOT NULL DEFAULT 0,              -- 宿舍容量（0=不限制）
  water_price      DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_price       DECIMAL(10,2) NOT NULL DEFAULT 0,
  remark           VARCHAR(200) NOT NULL DEFAULT '',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_rooms_building (building_id)
) ENGINE=InnoDB;

-- 物业库：tenants = 企业（企业业主，仅企业模式，无个人业主）
CREATE TABLE tenants (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  name       VARCHAR(100) NOT NULL,          -- 企业名称
  contact    VARCHAR(50) NOT NULL DEFAULT '',-- 联系人
  phone      VARCHAR(20) NOT NULL DEFAULT '',-- 联系电话（非必填）
  license_no VARCHAR(50) NOT NULL DEFAULT '',-- 营业执照/统一信用代码
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

-- 物业库：企业员工（企业业主名下的员工档案；不参与登录）
CREATE TABLE org_employees (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  org_id       INT NOT NULL,
  company      VARCHAR(100) NOT NULL,         -- 所属企业（文本，自动匹配/创建企业记录）
  owner_id     INT NULL,                      -- 绑定企业（tenants.id）
  room_id      INT NULL,                      -- 绑定房号（该企业名下房产）
  name         VARCHAR(50) NOT NULL,          -- 姓名
  id_number    VARCHAR(50) NOT NULL DEFAULT '',-- 身份证/护照
  phone        VARCHAR(20) NOT NULL DEFAULT '',
  department   VARCHAR(50) NOT NULL DEFAULT '',
  position     VARCHAR(50) NOT NULL DEFAULT '',
  card_no      VARCHAR(50) NOT NULL DEFAULT '',-- 门禁卡号（选填）
  photo_url    VARCHAR(255) NOT NULL DEFAULT '', -- 本人照片
  id_photo_url VARCHAR(255) NOT NULL DEFAULT '', -- 身份证/护照照片
  remark       VARCHAR(200) NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_emp_owner (owner_id), INDEX idx_emp_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE meters (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  room_id     INT NOT NULL,
  month       CHAR(7) NOT NULL,
  water_prev  DECIMAL(10,2) NOT NULL DEFAULT 0,
  water_curr  DECIMAL(10,2) NOT NULL DEFAULT 0,
  water_usage DECIMAL(10,2) NOT NULL DEFAULT 0,
  water_fee   DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_prev   DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_curr   DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_usage  DECIMAL(10,2) NOT NULL DEFAULT 0,
  elec_fee    DECIMAL(10,2) NOT NULL DEFAULT 0,
  remark      VARCHAR(200) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_room_month (room_id, month),
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

-- 房间宽带线路：一个房间可开通多条独立宽带，单价统一取经营主体设置
CREATE TABLE room_net_lines (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  org_id     INT NOT NULL,
  room_id    INT NOT NULL,
  line_name  VARCHAR(50) NOT NULL DEFAULT '默认线路',
  bandwidth  INT NOT NULL DEFAULT 0,           -- 当前带宽（兆）
  start_date DATE NULL,                        -- 开通日
  status     ENUM('active','stopped') NOT NULL DEFAULT 'active',
  stop_date  DATE NULL,                        -- 停用日（停用后不再计费）
  remark     VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_net_lines_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE net_changes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  org_id        INT NOT NULL,
  room_id       INT NOT NULL,
  line_id       INT NULL,                      -- 归属线路
  change_date   DATE NOT NULL,
  change_type   ENUM('add','reduce') NOT NULL DEFAULT 'add',
  old_bandwidth INT NOT NULL DEFAULT 0,
  new_bandwidth INT NOT NULL DEFAULT 0,
  remark        VARCHAR(200) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_net_changes_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE net_requests (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  org_id        INT NOT NULL,
  company_id    INT NULL,
  room_id       INT NOT NULL,
  type          ENUM('install','add','reduce') NOT NULL DEFAULT 'install',
  bandwidth     INT NULL,
  delta         INT NULL,
  line_id       INT NULL,
  reason        VARCHAR(500) NOT NULL DEFAULT '',
  status        ENUM('pending','done','rejected') NOT NULL DEFAULT 'pending',
  created_by    VARCHAR(64) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_by    VARCHAR(64) NOT NULL DEFAULT '',
  handle_note   VARCHAR(500) NOT NULL DEFAULT '',
  handled_at    DATETIME NULL,
  INDEX idx_org (org_id), INDEX idx_net_req_company (company_id), INDEX idx_net_req_room (room_id)
) ENGINE=InnoDB;

CREATE TABLE bills (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  org_id       INT NOT NULL,
  source       ENUM('property','utility','network','net_repair','install','repair','other') NOT NULL DEFAULT 'property',
  room_id      INT NOT NULL,
  tenant_id    INT NULL,
  contract_id  INT NULL,
  order_id     INT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  due_date     DATE NOT NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  status       ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
  pay_method   VARCHAR(20) NOT NULL DEFAULT '',
  pay_date     DATE NULL,
  remark       VARCHAR(500) NOT NULL DEFAULT '',
  items        JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id), INDEX idx_bills_room (room_id)
 ) ENGINE=InnoDB;

CREATE TABLE bill_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  transaction_type ENUM('receipt','refund') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bill_transactions_request (request_id),
  KEY idx_bill_transactions_bill_date (bill_id, transaction_date, id),
  CONSTRAINT chk_bill_transactions_amount CHECK (amount > 0),
  CONSTRAINT fk_bill_transactions_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE repairs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  room_id     INT NOT NULL,
  title       VARCHAR(100) NOT NULL,
  content     VARCHAR(500) NOT NULL DEFAULT '',
  status      ENUM('pending','processing','done') NOT NULL DEFAULT 'pending',
  handler     VARCHAR(50) NOT NULL DEFAULT '',
  handle_note VARCHAR(500) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE complaints (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  room_id     INT NOT NULL DEFAULT 0,
  owner_id    INT NULL,
  type        ENUM('投诉','建议','咨询','其他') NOT NULL DEFAULT '投诉',
  title       VARCHAR(100) NOT NULL,
  content     VARCHAR(500) NOT NULL DEFAULT '',
  status      ENUM('pending','processing','done') NOT NULL DEFAULT 'pending',
  handler     VARCHAR(50) NOT NULL DEFAULT '',
  handle_note VARCHAR(500) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id)
) ENGINE=InnoDB;
