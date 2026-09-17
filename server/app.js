'use strict';
/* ==================================================================
 * 房屋管理系统（租房 / 酒店 / 物业 · 多租户）· 后端服务
 * Node.js + Express + MariaDB · 端口 16088
 * 同一系统下可有多个经营主体（主管理员），业务数据按 org_id 行级隔离；
 * 三系统按能力裁剪（酒店无水电/网费/合同/投诉，租房与物业有水电/网费）。
 * ================================================================== */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const { shared, getPool, withMode, currentOrgId, currentMode, MODES } = require('./db');
const {
  hashPassword, verifyPassword, today, nowStr, addDays, addMonths, daysBetween,
  daysInMonth, monthStart, monthEnd
} = require('./util');
const { V, clean } = require('./validate');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
/* 上传图片静态访问（uploads/org-<主体ID>/，按主体隔离） */
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

/* ---------- 辅助 ---------- */
const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* 登录限流：同 IP 1 分钟最多 30 次尝试（防脚本爆破，兼顾正常使用与自动化测试） */
const loginHits = new Map();

/* ---------- 三系统能力矩阵 ---------- */
const FEATURES = {
  rental: {
    tables: ['buildings', 'rooms', 'tenants', 'contracts', 'meters', 'room_net_lines', 'net_changes', 'bills', 'repairs'],
    contract: true, order: false, meter: true, network: true, complaint: false, owner: false,
    /* 计费房间：已出租（有生效合同）；billable 用于无别名的 FROM rooms 查询 */
    billable: "status = 'rented'",
    settingsPrices: true
  },
  hotel: {
    tables: ['buildings', 'rooms', 'tenants', 'orders', 'bills', 'repairs'],
    contract: false, order: true, meter: false, network: false, complaint: false, owner: false,
    billable: null,
    settingsPrices: false
  },
  property: {
    tables: ['buildings', 'rooms', 'tenants', 'meters', 'room_net_lines', 'net_changes', 'bills', 'repairs', 'complaints'],
    contract: false, order: false, meter: true, network: true, complaint: true, owner: true,
    billable: 'owner_id IS NOT NULL',
    settingsPrices: true
  }
};
/* 房间可写字段（按系统裁剪；带宽/网费单价已迁移至宽带线路表，不在此维护） */const ROOM_FIELDS = {
  rental:   ['building_id','room_no','floor','area','rent','deposit','status','room_type',
             'water_price','elec_price','remark'],
  hotel:    ['building_id','room_no','floor','area','day_price','deposit','status','room_type','remark'],
  property: ['building_id','room_no','floor','area','status','room_type','owner_id','property_fee',
             'water_price','elec_price','remark']
};
const NUM_ROOM_FIELDS = ['building_id','floor','area','rent','deposit','day_price','owner_id','property_fee',
  'water_price','elec_price'];

/* 合同自动过期（仅租房库有 contracts） */
async function autoExpireContracts() {
  if (currentMode() !== 'rental') return;
  await pool.query("UPDATE contracts SET status='expired' WHERE status='active' AND end_date < ?", [today()]);
}

/* ==================================================================
 * 网费算法（租房 / 物业通用）
 * 一个房间可开通多条宽带线路（room_net_lines），单价统一取经营主体设置
 * ================================================================== */
/* 网费单价：统一取本经营主体「系统设置」（settings 在共享库，按 org_id 隔离） */
async function netUnitPrice() {
  const oid = currentOrgId();
  const [ss] = await shared.query('SELECT net_price_per_mb FROM settings WHERE org_id = ?', [oid]);
  return ss[0] ? Number(ss[0].net_price_per_mb) || 0 : 0;
}

/* 某线路在 date 当天的带宽（回滚该日之后的变更） */
async function getLineBandwidthAt(q, lineId, date) {
  const oid = currentOrgId();
  const [lines] = await q.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [lineId, oid]);
  const line = lines[0];
  if (!line) return null;
  let bw = Number(line.bandwidth) || 0;
  const [future] = await q.query(
    `SELECT old_bandwidth FROM net_changes WHERE line_id = ? AND org_id = ? AND change_date > ?
     ORDER BY change_date DESC, id DESC LIMIT 1`,
    [lineId, oid, date]);
  if (future[0]) bw = Number(future[0].old_bandwidth) || 0;
  return bw;
}

/* 房间某线路在指定月份的费用（开通日/停用日按天折算，变更分段计算） */
async function calcLineFee(q, line, month, price) {
  const dim = daysInMonth(month);
  const mStart = `${month}-01`;
  const mEnd = monthEnd(month);
  const effStart = line.start_date && String(line.start_date) > mStart ? String(line.start_date) : mStart;
  const effEnd = (line.status === 'stopped' && line.stop_date && String(line.stop_date) < mEnd)
    ? String(line.stop_date) : mEnd;
  if (effStart > effEnd) return { total: 0, segments: [] };
  /* 段天数 = 起止日差 + 1（同日为 1 天） */
  const segDays = (a, b) => Math.max(1, Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1);
  let bw = await getLineBandwidthAt(q, line.id, effStart);
  if (bw === null) return { total: 0, segments: [] };
  const [changes] = await q.query(
    `SELECT * FROM net_changes WHERE line_id = ? AND org_id = ? AND change_date > ? AND change_date <= ?
     ORDER BY change_date, id`, [line.id, currentOrgId(), effStart, effEnd]);
  const segments = [];
  let cursor = effStart;
  for (const c of changes) {
    const segEnd = addDays(c.change_date, -1);
    if (segEnd >= cursor) {
      const days = segDays(cursor, segEnd);
      segments.push({ start: cursor, end: segEnd, days, bandwidth: bw, price, fee: round2(bw * price * days / dim) });
    }
    cursor = c.change_date;
    bw = Number(c.new_bandwidth) || 0;
  }
  if (cursor <= effEnd) {
    const days = segDays(cursor, effEnd);
    segments.push({ start: cursor, end: effEnd, days, bandwidth: bw, price, fee: round2(bw * price * days / dim) });
  }
  const total = round2(segments.reduce((s, x) => s + x.fee, 0));
  return { total, segments };
}

/* 房间当月网费 = 各启用线路费用之和 */
async function calcNetFee(q, roomId, month) {
  const dim = daysInMonth(month);
  const oid = currentOrgId();
  const [lines] = await q.query(
    'SELECT * FROM room_net_lines WHERE room_id = ? AND org_id = ? ORDER BY id', [roomId, oid]);
  if (!lines.length) return { total: 0, segments: [], lines: [], daysInMonth: dim };
  const price = await netUnitPrice();
  const linesOut = [];
  let segments = [];
  let total = 0;
  for (const line of lines) {
    const calc = await calcLineFee(q, line, month, price);
    linesOut.push({ id: line.id, line_name: line.line_name, bandwidth: Number(line.bandwidth) || 0,
      start_date: line.start_date, status: line.status, stop_date: line.stop_date, total: calc.total,
      price, segments: calc.segments });
    segments = segments.concat(calc.segments);
    total = round2(total + calc.total);
  }
  return { total, segments, lines: linesOut, daysInMonth: dim };
}

/* 水电 + 物业账单构成（property 含物业费；rental 仅水电） */
async function billBreakdown(q, room, month) {
  const property_fee = room.property_fee ? Number(room.property_fee) || 0 : 0;
  const [ms] = await q.query('SELECT * FROM meters WHERE room_id = ? AND org_id = ? AND month = ?',
    [room.id, currentOrgId(), month]);
  const m = ms[0];
  const water_fee = m ? Number(m.water_fee) || 0 : 0;
  const elec_fee = m ? Number(m.elec_fee) || 0 : 0;
  return { property_fee, water_fee, elec_fee, total: round2(property_fee + water_fee + elec_fee), hasMeter: !!m };
}

/* ---------- 认证 ---------- */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  const [rows] = await shared.query(
    `SELECT u.id, u.username, u.real_name, u.role, u.mode AS user_mode, u.org_id, u.company_id,
            COALESCE(rc.name, rb.name) AS role_name, COALESCE(rc.level, rb.level) AS level,
            s.mode AS session_mode, s.org_id AS session_org, o.name AS org_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN roles rc ON rc.code = u.role AND rc.org_id = u.org_id
       LEFT JOIN roles rb ON rb.code = u.role AND rb.org_id IS NULL
       LEFT JOIN orgs o ON o.id = u.org_id
      WHERE s.token = ?`, [token]);
  if (!rows.length) return res.status(401).json({ error: '登录已过期' });
  const u = rows[0];
  req.user = {
    id: u.id, username: u.username, real_name: u.real_name,
    role: u.role, role_name: u.role_name || u.role, level: u.level || 'staff'
  };
  req.token = token;
  req.level = u.company_id ? 'company_admin' : (u.level || 'staff');
  req.companyId = u.company_id || null;
  req.mode = u.session_mode || u.user_mode || 'rental';
  req.orgId = u.session_org || u.org_id || null;
  req.orgName = u.org_name || null;
  const [perms] = [await userPerms(u.id)];
  req.pages = perms.pages;
  req.ops = perms.ops;
  next();
}
const wrap = (req, res, next) => withMode(req.mode, req.orgId, next);
const authMode = (req, res, next) => authenticate(req, res, () => wrap(req, res, next));

/* 集中式页面权限（员工按授予页面；主管理员/超管全放行） */
const ROUTE_PAGES = [
  [/^\/stats/, ['dashboard']],
  [/^\/buildings/, ['rooms', 'roommap', 'buildings', 'properties', 'meters', 'network']],
  [/^\/rooms/, ['rooms', 'roommap', 'properties']],
  [/^\/tenants/, ['tenants', 'owners']],
  [/^\/contracts/, ['contracts']],
  [/^\/orders/, ['orders']],
  [/^\/bills/, ['bills', 'network']],
  [/^\/meters/, ['meters']],
  [/^\/netChanges/, ['network']],
  [/^\/netfee/, ['network']],
  [/^\/netRequests/, ['network']],
  [/^\/repairs/, ['repairs']],
  [/^\/complaints/, ['complaints']]
];
/* 路由 → 所需系统能力（不属于本系统的接口直接拒绝） */
const ROUTE_FEATURE = [
  [/^\/contracts/, 'contract'],
  [/^\/orders/, 'order'],
  [/^\/meters/, 'meter'],
  [/^\/netChanges/, 'network'],
  [/^\/netfee/, 'network'],
  [/^\/netRequests/, 'network'],
  [/^\/complaints/, 'complaint']
];
function checkPagePerm(req) {
  if (req.level === 'super' || req.level === 'admin') return true;
  for (const [re, pages] of ROUTE_PAGES) {
    if (re.test(req.path)) return (req.pages || []).some(p => pages.includes(p));
  }
  return true;
}
function checkFeature(req) {
  const f = FEATURES[req.mode];
  for (const [re, key] of ROUTE_FEATURE) {
    if (re.test(req.path) && !f[key]) return false;
  }
  return true;
}
/* 业务写操作 → 所需操作权限（动作级；员工角色 ops；主管理员不受限，企业管理员见 authPerm） */
const OP_ROUTES = [
  [/^\/buildings$/, 'building_add', 'POST'],
  [/^\/buildings\/\d+$/, 'building_edit', 'PUT'],
  [/^\/buildings\/\d+$/, 'building_delete', 'DELETE'],
  [/^\/rooms$/, 'room_add', 'POST'],
  [/^\/rooms\/\d+$/, 'room_edit', 'PUT'],
  [/^\/rooms\/\d+$/, 'room_delete', 'DELETE'],
  [/^\/tenants$/, 'tenant_add', 'POST'],
  [/^\/tenants\/\d+$/, 'tenant_edit', 'PUT'],
  [/^\/tenants\/\d+$/, 'tenant_delete', 'DELETE'],
  [/^\/tenants\/\d+\/company-admin$/, 'tenant_edit', 'POST'],
  [/^\/contracts$/, 'contract_add', 'POST'],
  [/^\/contracts\/\d+$/, 'contract_edit', 'PUT'],
  [/^\/contracts\/\d+$/, 'contract_delete', 'DELETE'],
  [/^\/orders$/, 'order_add', 'POST'],
  [/^\/orders\/\d+$/, 'order_edit', 'PUT'],
  [/^\/orders\/\d+$/, 'order_delete', 'DELETE'],
  [/^\/orders\/\d+\/(checkin|checkout|cancel)$/, 'order_status', 'POST'],
  [/^\/org-employees$/, 'orgemp_add', 'POST'],
  [/^\/org-employees\/\d+$/, 'orgemp_edit', 'PUT'],
  [/^\/org-employees\/\d+$/, 'orgemp_delete', 'DELETE'],
  [/^\/meters$/, 'meter_add', 'POST'],
  [/^\/meters\/\d+$/, 'meter_edit', 'PUT'],
  [/^\/meters\/\d+$/, 'meter_delete', 'DELETE'],
  [/^\/netLines$/, 'netline_add', 'POST'],
  [/^\/netLines\/\d+$/, 'netline_edit', 'PUT'],
  [/^\/netLines\/\d+\/(stop|start)$/, 'netline_status', 'POST'],
  [/^\/netChanges$/, 'netline_bandwidth', 'POST'],
  [/^\/netChanges\/\d+$/, 'netline_bandwidth', 'DELETE'],
  [/^\/netRequests$/, 'netline_bandwidth', 'POST'],
  [/^\/bills$/, 'bill_add', 'POST'],
  [/^\/bills\/generate$/, 'bill_generate', 'POST'],
  [/^\/bills\/update-network$/, 'bill_generate', 'POST'],
  [/^\/bills\/\d+$/, 'bill_delete', 'DELETE'],
  [/^\/bills\/\d+\/pay$/, 'bill_pay', 'POST'],
  [/^\/repairs$/, 'repair_add', 'POST'],
  [/^\/repairs\/\d+$/, 'repair_handle', 'PUT'],
  [/^\/repairs\/\d+$/, 'repair_delete', 'DELETE'],
  [/^\/complaints$/, 'complaint_add', 'POST'],
  [/^\/complaints\/\d+$/, 'complaint_handle', 'PUT'],
  [/^\/complaints\/\d+$/, 'complaint_delete', 'DELETE']
];
const authPerm = (req, res, next) => authMode(req, res, () => {
  /* 超级管理员只负责开通主体与系统监控，不参与任何业务数据读写 */
  if (req.level === 'super') return res.status(403).json({ error: '超级管理员不参与业务操作' });
  if (req.method !== 'GET') {
    if (req.level === 'company_admin') {
      /* 企业管理员：写操作按角色 ops 放行，且仅限带企业维度的数据（房产/抄表/宽带/账单/报修/投诉），
       * 楼栋等主体级基础设施及租房/酒店业务一律不可写；数据范围在接口内按本企业校验 */
      const need = OP_ROUTES.find(r => (!r[2] || r[2] === req.method) && r[0].test(req.path));
      const okRoute = /^\/(rooms|meters|netLines|netChanges|netRequests|bills|repairs|complaints)(\/|$)/.test(req.path);
      if (!need || !okRoute || !(req.ops || []).includes(need[1])) {
        return res.status(403).json({ error: '企业管理员无此操作权限' });
      }
    } else if (req.level === 'staff') {
      /* 员工：写操作按角色操作权限（ops）放行 */
      const need = OP_ROUTES.find(r => (!r[2] || r[2] === req.method) && r[0].test(req.path));
      if (!need || !(req.ops || []).includes(need[1])) {
        return res.status(403).json({ error: '无此操作权限' });
      }
    }
  }
  if (!checkFeature(req)) return res.status(404).json({ error: '当前系统不提供该功能' });
  if (!checkPagePerm(req)) return res.status(403).json({ error: '无权访问该功能' });
  next();
});

/* 企业管理员写入：目标房产必须属于本企业（其他身份恒通过） */
async function ownRoomCheck(req, roomId) {
  if (!roomId || req.level !== 'company_admin') return true;
  const [[rm]] = await pool.query(
    'SELECT id FROM rooms WHERE id = ? AND org_id = ? AND owner_id = ?',
    [roomId, req.orgId, req.companyId]);
  return !!rm;
}
const auth = authPerm;

const superOnly = (req, res, next) => {
  if (req.level !== 'super') return res.status(403).json({ error: '需要超级管理员权限' });
  next();
};
const adminLevel = (req, res, next) => {
  if (req.level !== 'super' && req.level !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
};
/* 主管理员（经营主体管理员；超管不走业务管理） */
const orgAdminOnly = (req, res, next) => {
  if (req.level !== 'admin') return res.status(403).json({ error: '需要主管理员权限' });
  next();
};

const router = express.Router();

/* 员工实际权限（页面访问 + 操作）全部来自角色，按主体隔离，改角色即时生效；
 * role_permissions 中 `op:` 前缀为操作权限，其余为页面访问权限 */
async function userPerms(userId) {
  const [[u]] = await shared.query('SELECT role, org_id FROM users WHERE id = ?', [userId]);
  const pages = [], ops = [];
  if (u && u.role) {
    const [rps] = await shared.query(
      `SELECT rp.page FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = ? AND r.org_id = ?`, [u.role, u.org_id]);
    for (const p of rps) {
      const v = String(p.page);
      if (v.startsWith('op:')) ops.push(v.slice(3));
      else pages.push(v);
    }
  }
  return { pages: [...new Set(pages)], ops: [...new Set(ops)] };
}
/* 覆盖写角色权限（主管理员自建角色；内置/全局角色不设权限）：pages 存裸名，ops 存 op: 前缀 */
async function setRolePerms(roleId, pages, ops) {
  await shared.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  const items = [];
  if (Array.isArray(pages)) for (const p of new Set(pages)) items.push([roleId, p]);
  if (Array.isArray(ops)) for (const o of new Set(ops)) items.push([roleId, 'op:' + o]);
  for (const it of items) {
    await shared.query('INSERT IGNORE INTO role_permissions (role_id, page) VALUES (?, ?)', it);
  }
}
/* 读取角色权限：返回 { pages, ops } */
async function rolePerms(roleId) {
  const [rps] = await shared.query('SELECT page FROM role_permissions WHERE role_id = ?', [roleId]);
  const pages = [], ops = [];
  for (const p of rps) {
    const v = String(p.page);
    if (v.startsWith('op:')) ops.push(v.slice(3));
    else pages.push(v);
  }
  return { pages: [...new Set(pages)], ops: [...new Set(ops)] };
}

/* ==================================================================
 * 登录 / 会话
 * ================================================================== */
router.post('/login', h(async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '?';
  const nowT = Date.now();
  const hit = loginHits.get(ip) || { n: 0, t: nowT };
  if (nowT - hit.t > 60000) { hit.n = 0; hit.t = nowT; }
  hit.n++;
  loginHits.set(ip, hit);
  if (hit.n > 30) return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' });
  const B = req.body || {};
  const v = V(B);
  const username = v.str('username', { required: true, max: 50 });
  const password = v.str('password', { required: true, max: 100, clean: false });
  v.ok();
  /* 入口强绑定：账号必须从所属系统窗口登录（超管=super 窗口；业务账号=对应系统窗口）。
   * 跨系统信息一律不外泄——查不到/不匹配统一返回「用户名或密码错误」。 */
  const modeQ = B.mode === 'super' ? 'AND u.mode IS NULL'
              : B.mode            ? 'AND u.mode = ?'
              : 'AND 1 = 0';
  const params = [username || '', ...(B.mode && B.mode !== 'super' ? [B.mode] : [])];  const [rows] = await shared.query(
    `SELECT u.*, COALESCE(rc.name, rb.name) AS role_name, COALESCE(rc.level, rb.level) AS level,
            o.name AS org_name
       FROM users u
       LEFT JOIN roles rc ON rc.code = u.role AND rc.org_id = u.org_id
       LEFT JOIN roles rb ON rb.code = u.role AND rb.org_id IS NULL
       LEFT JOIN orgs o ON o.id = u.org_id
      WHERE u.username = ? ${modeQ}`, params);
  const u = rows[0];
  if (!u || !verifyPassword(password, u.password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }
  const mode = u.mode || 'rental';
  const isCompanyAdmin = !!u.company_id;
  /* 企业管理员附加企业名（tenants 在业务库，登录后单独查） */
  let company_name = null;
  if (u.company_id) {
    const [[tc]] = await getPool(mode).query(
      'SELECT name FROM tenants WHERE id = ? AND org_id = ?', [u.company_id, u.org_id]);
    company_name = tc ? tc.name : null;
  }
  const token = crypto.randomBytes(32).toString('hex');
  await shared.query('INSERT INTO sessions (token, user_id, mode, org_id) VALUES (?, ?, ?, ?)',
    [token, u.id, mode, u.org_id || null]);
  const pages = await userPerms(u.id);
  res.json({
    id: u.id, username: u.username, name: u.real_name,
    role: u.role, role_name: u.role_name,
    level: isCompanyAdmin ? 'company_admin' : (u.level || 'staff'),
    company_id: u.company_id || null,
    mode, org_id: u.org_id || null, org_name: u.org_name || null,
    company_name,
    pages: pages.pages, ops: pages.ops, token
  });
}));

router.get('/me', authMode, h(async (req, res) => {
  const perms = await userPerms(req.user.id);
  let company_name = null;
  if (req.companyId) {
    const [[tc]] = await pool.query('SELECT name FROM tenants WHERE id = ? AND org_id = ?', [req.companyId, req.orgId]);
    company_name = tc ? tc.name : null;
  }
  res.json({
    id: req.user.id, username: req.user.username, name: req.user.real_name,
    role: req.user.role, role_name: req.user.role_name,
    level: req.level, mode: req.mode, org_id: req.orgId, org_name: req.orgName,
    company_id: req.companyId || null, company_name,
    pages: perms.pages, ops: perms.ops
  });
}));

router.post('/logout', authMode, h(async (req, res) => {
  await shared.query('DELETE FROM sessions WHERE token = ?', [req.token]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 经营主体（超管开通/管理主管理员）
 * ================================================================== */
router.get('/orgs', authMode, superOnly, h(async (req, res) => {
  const [orgs] = await shared.query('SELECT * FROM orgs ORDER BY id');
  const out = [];
  for (const o of orgs) {
    const [[adm]] = await shared.query(
      'SELECT id, username, real_name FROM users WHERE id = ?', [o.admin_user_id]);
    const p = getPool(o.mode);
    const [[rc]] = await p.query('SELECT COUNT(*) AS c FROM rooms WHERE org_id = ?', [o.id]);
    const [[bc]] = await p.query('SELECT COUNT(*) AS c FROM bills WHERE org_id = ?', [o.id]);
    const [[st]] = await shared.query(
      "SELECT COUNT(*) AS c FROM users WHERE org_id = ? AND role <> 'admin'", [o.id]);
    out.push({
      id: o.id, name: o.name, mode: o.mode,
      admin: adm || null, room_count: Number(rc.c), bill_count: Number(bc.c), staff_count: Number(st.c),
      created_at: o.created_at
    });
  }
  res.json(out);
}));

router.post('/orgs', authMode, superOnly, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { required: true, max: 50 });
  const mode = v.str('mode', { required: true, enum: MODES });
  const username = v.str('username', { required: true, max: 50, pattern: /^[A-Za-z0-9_@.\-]+$/ });
  const password = v.str('password', { required: true, max: 100, clean: false });
  const real_name = v.str('real_name', { max: 50 });
  v.ok();
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const [[dup]] = await shared.query('SELECT COUNT(*) AS c FROM users WHERE username = ?', [username]);
  if (Number(dup.c) > 0) return res.status(400).json({ error: '用户名已存在' });

  const conn = await shared.getConnection();
  try {
    await conn.beginTransaction();
    const [orgR] = await conn.query('INSERT INTO orgs (name, mode) VALUES (?, ?)', [name, mode]);
    const orgId = orgR.insertId;
    const [uR] = await conn.query(
      'INSERT INTO users (username, password, real_name, role, mode, org_id) VALUES (?, ?, ?, ?, ?, ?)',
      [username, hashPassword(password), real_name || name + '管理员', 'admin', mode, orgId]);
    await conn.query('UPDATE orgs SET admin_user_id = ? WHERE id = ?', [uR.insertId, orgId]);
    await conn.query(
      'INSERT INTO settings (org_id, currency, rate, net_price_per_mb, water_price, elec_price) VALUES (?, ?, ?, ?, ?, ?)',
      [orgId, 'USD', 7.2, 1.0, 4.5, 1.0]);
    await conn.commit();
    res.json({ ok: true, org_id: orgId });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

router.put('/orgs/:id', authMode, superOnly, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { max: 50 });
  const real_name = v.str('real_name', { max: 50 });
  const password = v.str('password', { max: 100, clean: false });
  v.ok();
  const [os] = await shared.query('SELECT * FROM orgs WHERE id = ?', [req.params.id]);
  if (!os.length) return res.status(400).json({ error: '经营主体不存在' });
  const o = os[0];
  if (name !== null) {
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    await shared.query('UPDATE orgs SET name = ? WHERE id = ?', [name, o.id]);
  }
  if (real_name !== null) {
    await shared.query('UPDATE users SET real_name = ? WHERE id = ?', [real_name || '', o.admin_user_id]);
  }
  if (password !== null && password) {
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    await shared.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(password), o.admin_user_id]);
  }
  res.json({ ok: true });
}));

router.delete('/orgs/:id', authMode, superOnly, h(async (req, res) => {
  const [os] = await shared.query('SELECT * FROM orgs WHERE id = ?', [req.params.id]);
  if (!os.length) return res.status(400).json({ error: '经营主体不存在' });
  const o = os[0];
  /* 清空该主体在所属系统库的全部业务数据 */
  const p = getPool(o.mode);
  for (const t of FEATURES[o.mode].tables || []) {
    await p.query(`DELETE FROM ${t} WHERE org_id = ?`, [o.id]);
  }
  /* 共享库：员工权限/会话/员工账号、设置、自建角色、主体（主管理员账号） */
  const [staff] = await shared.query('SELECT id FROM users WHERE org_id = ?', [o.id]);
  for (const u of staff) {
    await shared.query('DELETE FROM user_permissions WHERE user_id = ?', [u.id]);
    await shared.query('DELETE FROM sessions WHERE user_id = ?', [u.id]);
  }
  await shared.query('DELETE FROM users WHERE org_id = ?', [o.id]);
  await shared.query('DELETE FROM settings WHERE org_id = ?', [o.id]);
  await shared.query('DELETE FROM roles WHERE org_id = ?', [o.id]);
  await shared.query('DELETE FROM sessions WHERE org_id = ?', [o.id]);
  await shared.query('DELETE FROM orgs WHERE id = ?', [o.id]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 系统设置（按经营主体独立；酒店仅汇率/币种）
 * ================================================================== */
const DEF_SETTINGS = { currency: 'USD', rate: 7.2, net_price_per_mb: 1, water_price: 4.5, elec_price: 1 };
async function getOrgSettings(orgId) {
  const [rows] = await shared.query('SELECT * FROM settings WHERE org_id = ?', [orgId]);
  return rows[0] || null;
}
router.get('/settings', authMode, h(async (req, res) => {
  if (!req.orgId) return res.json({ mode: req.mode, ...DEF_SETTINGS, prices: false, item_lib: [] });
  const s = await getOrgSettings(req.orgId);
  const base = s || { org_id: req.orgId, ...DEF_SETTINGS };
  let lib = [];
  if (base.item_lib) {
    try { const raw = typeof base.item_lib === 'string' ? JSON.parse(base.item_lib) : base.item_lib; if (Array.isArray(raw)) lib = raw; } catch (e) { /* 忽略损坏数据 */ }
  }
  res.json({
    currency: base.currency, rate: Number(base.rate),
    net_price_per_mb: Number(base.net_price_per_mb),
    water_price: Number(base.water_price), elec_price: Number(base.elec_price),
    prices: FEATURES[req.mode].settingsPrices,
    item_lib: lib
  });
}));

router.put('/settings', authMode, orgAdminOnly, h(async (req, res) => {
  const B = req.body || {};
  const s = (await getOrgSettings(req.orgId)) || { ...DEF_SETTINGS };
  const v = V(B);
  const currency = v.str('currency', { enum: ['CNY', 'USD'], def: s.currency });
  const rate = v.num('rate', { min: 0.01, max: 10000, def: Number(s.rate) });
  let net = Number(s.net_price_per_mb), water = Number(s.water_price), elec = Number(s.elec_price);
  if (FEATURES[req.mode].settingsPrices) {
    net = v.num('net_price_per_mb', { min: 0, max: 1e7, def: net });
    water = v.num('water_price', { min: 0, max: 1e7, def: water });
    elec = v.num('elec_price', { min: 0, max: 1e7, def: elec });
  }
  v.ok();
  /* 常用商品库：{name, model, price, cat} 数组，≤200 条，仅主管理员可写 */
  let lib = null;
  if (B.item_lib !== undefined) {
    if (!Array.isArray(B.item_lib) || B.item_lib.length > 200) {
      return res.status(400).json({ error: '商品库须为不超过 200 条的数组' });
    }
    lib = [];
    for (const it of B.item_lib) {
      const name = String(it.name || '').trim();
      if (!name) return res.status(400).json({ error: '商品名称不能为空' });
      if (name.length > 100) return res.status(400).json({ error: '商品名称不能超过 100 字' });
      const model = it.model === undefined || it.model === null ? '' : String(it.model).trim();
      if (model.length > 100) return res.status(400).json({ error: '商品型号不能超过 100 字' });
      const price = Number(it.price);
      if (!Number.isFinite(price) || price < 0 || price > 1e7) {
        return res.status(400).json({ error: '商品单价不合法' });
      }
      const cat = it.cat === 'util' ? 'util' : 'net';
      lib.push({ name, model, price: Math.round(price * 100) / 100, cat });
    }
  }
  await shared.query(
    `INSERT INTO settings (org_id, currency, rate, net_price_per_mb, water_price, elec_price, item_lib)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE currency = VALUES(currency), rate = VALUES(rate),
       net_price_per_mb = VALUES(net_price_per_mb), water_price = VALUES(water_price),
       elec_price = VALUES(elec_price)${lib !== null ? ', item_lib = VALUES(item_lib)' : ''}`,
    [req.orgId, currency, rate, net, water, elec, lib !== null ? JSON.stringify(lib) : null]);
  res.json({ currency, rate: Number(rate), net_price_per_mb: net, water_price: water, elec_price: elec,
    prices: FEATURES[req.mode].settingsPrices, item_lib: lib !== null ? lib : (() => { try { return JSON.parse(s.item_lib || '[]'); } catch (e) { return []; } })() });
}));

/* ==================================================================
 * 全局配置（超管级，与经营主体无关；登录页公开读取，仅超管可写）
 * ================================================================== */
const APP_CFG_DEFAULTS = { login_selector: 'show', login_default: 'rental' };
async function getAppConfig() {
  const [rows] = await shared.query('SELECT k, v FROM app_config');
  const cfg = { ...APP_CFG_DEFAULTS };
  for (const r of rows) if (r.k in cfg) cfg[r.k] = r.v;
  return cfg;
}
router.get('/app-config', h(async (req, res) => {
  res.json(await getAppConfig());
}));
router.put('/app-config', authMode, superOnly, h(async (req, res) => {
  const B = req.body || {};
  const cfg = await getAppConfig();
  const selector = (B.login_selector === 'show' || B.login_selector === 'hide')
    ? B.login_selector : cfg.login_selector;
  const def = ['rental', 'hotel', 'property', 'super'].includes(B.login_default)
    ? B.login_default : cfg.login_default;
  for (const [k, v] of Object.entries({ login_selector: selector, login_default: def })) {
    await shared.query(
      'INSERT INTO app_config (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
  }
  res.json(await getAppConfig());
}));

/* 本主体默认单价（房间新增自动填入） */
async function getOrgPrices() {
  if (!currentOrgId()) return { net_price_per_mb: 1, water_price: 4.5, elec_price: 1 };
  const s = await getOrgSettings(currentOrgId());
  const pick = (v, d) => (s && Number.isFinite(Number(s[v])) && Number(s[v]) >= 0) ? Number(s[v]) : d;
  return {
    net_price_per_mb: pick('net_price_per_mb', 1),
    water_price: pick('water_price', 4.5),
    elec_price: pick('elec_price', 1)
  };
}

/* ==================================================================
 * 统计（按系统能力分支；始终返回完整字段，缺省为 0/空）
 * ================================================================== */
router.get('/stats', auth, h(async (req, res) => {
  const mode = req.mode, f = FEATURES[mode], t = today(), ym = t.slice(0, 7);
  const oid = req.orgId;
  /* 企业管理员：全部统计仅限本企业房产 */
  const so = req.level === 'company_admin' ? Number(req.companyId) : null;
  const soAnd = (alias) => (so ? ` AND ${alias}.owner_id = ${so}` : '');
  const soAndNoAlias = () => (so ? ' AND owner_id = ' + so : '');
  const empty = () => ({
    total_rooms: 0, vacant: 0, rented: 0, booked: 0, cleaning: 0, maintenance: 0, occupancy: 0,
    month_receivable: 0, month_received: 0, arrears: 0, pending_repairs: 0,
    today_checkin: 0, today_checkout: 0, today_revenue: 0, staying_deposit: 0,
    expiring: [], recent_bills: [], recent_orders: [], dirty_rooms: [],
    owner_count: 0, emp_count: 0, property_receivable: 0, property_received: 0, property_arrears: 0, pay_rate: 0,
    pending_complaints: 0, month_repairs: 0,
    meter_water_fee: 0, meter_elec_fee: 0, meter_water_usage: 0, meter_elec_usage: 0,
    net_receivable: 0, net_received: 0, net_arrears: 0,
    total_bandwidth: 0, net_estimate_month: 0, net_change_month: 0,
    recent_complaints: [], arrears_rooms: []
  });
  const R = empty();

  const [[roomStat]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status='vacant'),0) AS vacant,
            COALESCE(SUM(status='rented'),0) AS rented,
            COALESCE(SUM(status='booked'),0) AS booked,
            COALESCE(SUM(status='cleaning'),0) AS cleaning,
            COALESCE(SUM(status='maintenance'),0) AS maintenance
       FROM rooms r WHERE r.org_id = ?${soAnd('r')}`, [oid]);
  Object.assign(R, {
    total_rooms: Number(roomStat.total), vacant: Number(roomStat.vacant), rented: Number(roomStat.rented),
    booked: Number(roomStat.booked), cleaning: Number(roomStat.cleaning), maintenance: Number(roomStat.maintenance)
  });
  R.occupancy = R.total_rooms ? Math.round(R.rented / R.total_rooms * 100) : 0;

  const [monthBills] = await pool.query(
    `SELECT b.amount, b.paid_amount FROM bills b JOIN rooms r ON r.id = b.room_id
      WHERE b.org_id = ?${soAnd('r')} AND (b.due_date LIKE ? OR b.period_start LIKE ?)`,
    [oid, ym + '%', ym + '%']);
  R.month_receivable = round2(monthBills.reduce((s, b) => s + Number(b.amount), 0));
  R.month_received = round2(monthBills.reduce((s, b) => s + Number(b.paid_amount || 0), 0));
  const [allBills] = await pool.query(
    `SELECT b.amount, b.paid_amount FROM bills b JOIN rooms r ON r.id = b.room_id
      WHERE b.org_id = ?${soAnd('r')}`, [oid]);
  R.arrears = round2(allBills.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0));
  const [[rp]] = await pool.query(
    `SELECT COUNT(*) AS c FROM repairs x JOIN rooms rm ON rm.id = x.room_id
      WHERE x.org_id = ?${soAnd('rm')} AND x.status <> 'done'`, [oid]);
  R.pending_repairs = Number(rp.c);
  const [[mr]] = await pool.query(
    `SELECT COUNT(*) AS c FROM repairs x JOIN rooms rm ON rm.id = x.room_id
      WHERE x.org_id = ?${soAnd('rm')} AND x.created_at LIKE ?`, [oid, ym + '%']);
  R.month_repairs = Number(mr.c);

  const [recentBills] = await pool.query(
    `SELECT b.*, r.room_no, t.name AS tenant_name
       FROM bills b LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN tenants t ON t.id = b.tenant_id
      WHERE b.org_id = ?${soAnd('r')} ORDER BY b.id DESC LIMIT 6`, [oid]);
  R.recent_bills = recentBills.map(b => ({ ...b, amount: Number(b.amount), paid_amount: Number(b.paid_amount) }));

  /* 租房：合同到期 + 水电 + 网费 */
  if (f.contract) {
    await autoExpireContracts();
    const [expiring] = await pool.query(
      `SELECT c.*, r.room_no, b.name AS building_name, t.name AS tenant_name, t.phone
         FROM contracts c
         JOIN rooms r ON r.id = c.room_id
         JOIN buildings b ON b.id = r.building_id
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.org_id = ? AND c.status = 'active' AND c.end_date >= ? AND c.end_date <= ?
        ORDER BY c.end_date`, [oid, t, addDays(t, 30)]);
    R.expiring = expiring.map(c => ({ ...c, rent: Number(c.rent), deposit: Number(c.deposit),
      days_left: daysBetween(t, c.end_date) }));
  }

  /* 酒店：订单相关 */
  if (f.order) {
    const [[ci]] = await pool.query(
      "SELECT COUNT(*) AS c FROM orders WHERE org_id = ? AND check_in_date = ? AND status <> 'cancelled'", [oid, t]);
    const [[co]] = await pool.query(
      "SELECT COUNT(*) AS c FROM orders WHERE org_id = ? AND check_out_date = ? AND status <> 'cancelled'", [oid, t]);
    const [[rev]] = await pool.query(
      'SELECT COALESCE(SUM(paid_amount),0) AS c FROM bills WHERE org_id = ? AND pay_date = ?', [oid, t]);
    const [[dep]] = await pool.query(
      "SELECT COALESCE(SUM(deposit),0) AS c FROM orders WHERE org_id = ? AND status = 'checked_in'", [oid]);
    R.today_checkin = Number(ci.c); R.today_checkout = Number(co.c);
    R.today_revenue = Number(rev.c); R.staying_deposit = Number(dep.c);
    const [recentOrders] = await pool.query(
      `SELECT o.*, r.room_no, b.name AS building_name, t.name AS guest_name
         FROM orders o JOIN rooms r ON r.id = o.room_id
         JOIN buildings b ON b.id = r.building_id JOIN tenants t ON t.id = o.guest_id
        WHERE o.org_id = ? ORDER BY o.id DESC LIMIT 6`, [oid]);
    R.recent_orders = recentOrders.map(o => ({ ...o, days: Number(o.days), day_price: Number(o.day_price),
      total: Number(o.total), deposit: Number(o.deposit) }));
    const [dirty] = await pool.query(
      `SELECT r.*, b.name AS building_name FROM rooms r JOIN buildings b ON b.id = r.building_id
        WHERE r.org_id = ? AND r.status = 'cleaning'`, [oid]);
    R.dirty_rooms = dirty;
  }

  /* 物业：企业 */
  if (f.owner) {
    const [ownedRooms] = await pool.query(
      `SELECT r.*, b.name AS building_name, t.name AS owner_name, t.phone AS owner_phone
         FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id
         LEFT JOIN tenants t ON t.id = r.owner_id
        WHERE r.org_id = ? AND r.owner_id IS NOT NULL${soAnd('r')}`, [oid]);
    R.owner_count = new Set(ownedRooms.map(r => r.owner_id)).size;
    const [[ec]] = await pool.query(
      'SELECT COUNT(*) AS c FROM org_employees WHERE org_id = ?' + soAndNoAlias(), [oid]);
    R.emp_count = Number(ec.c);
    const [[bwRow]] = await pool.query(
      `SELECT COALESCE(SUM(l.bandwidth),0) AS s FROM room_net_lines l JOIN rooms r ON r.id = l.room_id
        WHERE l.org_id = ? AND l.status = 'active' AND r.owner_id IS NOT NULL${soAnd('r')}`, [oid]);
    R.total_bandwidth = Number(bwRow.s);
    for (const r of ownedRooms) R.net_estimate_month += (await calcNetFee(pool, r.id, ym)).total;
    R.net_estimate_month = round2(R.net_estimate_month);
    R.arrears_rooms = computeArrearsRooms(ownedRooms, allBills);
  }

  /* 水电抄表（租房/物业） */
  if (f.meter) {
    const [monthMeters] = await pool.query(
      `SELECT m.* FROM meters m JOIN rooms r ON r.id = m.room_id
        WHERE m.org_id = ?${soAnd('r')} AND m.month = ?`, [oid, ym]);
    R.meter_water_fee = monthMeters.reduce((s, m) => s + Number(m.water_fee || 0), 0);
    R.meter_elec_fee = monthMeters.reduce((s, m) => s + Number(m.elec_fee || 0), 0);
    R.meter_water_usage = monthMeters.reduce((s, m) => s + Number(m.water_usage || 0), 0);
    R.meter_elec_usage = monthMeters.reduce((s, m) => s + Number(m.elec_usage || 0), 0);
  }

  /* 网费（租房/物业） */
  if (f.network) {
    const [netBills] = await pool.query(
      `SELECT b.* FROM bills b JOIN rooms r ON r.id = b.room_id
        WHERE b.org_id = ?${soAnd('r')} AND b.source = 'network'`, [oid]);
    const netMonth = netBills.filter(b => (b.due_date || '').startsWith(ym) || (b.period_start || '').startsWith(ym));
    R.net_receivable = round2(netMonth.reduce((s, b) => s + Number(b.amount), 0));
    R.net_received = round2(netMonth.reduce((s, b) => s + Number(b.paid_amount || 0), 0));
    R.net_arrears = round2(netBills.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0));
    const [[ncm]] = await pool.query(
      `SELECT COUNT(*) AS c FROM net_changes n JOIN rooms r ON r.id = n.room_id
        WHERE n.org_id = ?${soAnd('r')} AND n.change_date LIKE ?`, [oid, ym + '%']);
    R.net_change_month = Number(ncm.c);
    if (!f.owner) {
      /* 租房：网费房间为已出租房间 */
      const [rentedRooms] = await pool.query(
        `SELECT r.*, b.name AS building_name FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id
          WHERE r.org_id = ? AND r.status = 'rented'${soAnd('r')}`, [oid]);
      const [[bwRow]] = await pool.query(
        `SELECT COALESCE(SUM(l.bandwidth),0) AS s FROM room_net_lines l JOIN rooms r ON r.id = l.room_id
          WHERE l.org_id = ? AND l.status = 'active' AND r.status = 'rented'${soAnd('r')}`, [oid]);
      R.total_bandwidth = Number(bwRow.s);
      for (const r of rentedRooms) R.net_estimate_month += (await calcNetFee(pool, r.id, ym)).total;
      R.net_estimate_month = round2(R.net_estimate_month);
      R.arrears_rooms = computeArrearsRooms(rentedRooms, allBills);
    }
    /* 物业账单口径（物业费+水电） */
    if (f.owner) {
      const [propertyBills] = await pool.query(
        `SELECT b.* FROM bills b JOIN rooms r ON r.id = b.room_id
          WHERE b.org_id = ?${soAnd('r')} AND b.source = 'property'`, [oid]);
      const pm = propertyBills.filter(b => (b.due_date || '').startsWith(ym) || (b.period_start || '').startsWith(ym));
      R.property_receivable = round2(pm.reduce((s, b) => s + Number(b.amount), 0));
      R.property_received = round2(pm.reduce((s, b) => s + Number(b.paid_amount || 0), 0));
      R.property_arrears = round2(propertyBills.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0));
      R.pay_rate = R.property_receivable ? Math.round(R.property_received / R.property_receivable * 100) : 0;
    }
  }

  /* 投诉（物业） */
  if (f.complaint) {
    const [[pc]] = await pool.query(
      `SELECT COUNT(*) AS c FROM complaints c JOIN rooms r ON r.id = c.room_id
        WHERE c.org_id = ?${soAnd('r')} AND c.status <> 'done'`, [oid]);
    R.pending_complaints = Number(pc.c);
    const [recentComplaints] = await pool.query(
      `SELECT c.*, r.room_no, b.name AS building_name, t.name AS owner_name
         FROM complaints c LEFT JOIN rooms r ON r.id = c.room_id
         LEFT JOIN buildings b ON b.id = r.building_id LEFT JOIN tenants t ON t.id = c.owner_id
        WHERE c.org_id = ?${soAnd('r')} ORDER BY c.id DESC LIMIT 6`, [oid]);
    R.recent_complaints = recentComplaints;
  }

  res.json(R);
}));

function computeArrearsRooms(rooms, allBills) {
  const out = [];
  for (const r of rooms) {
    const oweP = allBills.filter(b => b.room_id === r.id && b.source !== 'network')
      .reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0);
    const oweN = allBills.filter(b => b.room_id === r.id && b.source === 'network')
      .reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0);
    const owe = round2(oweP + oweN);
    if (owe > 0) {
      out.push({
        id: r.id, room_no: r.room_no, building_name: r.building_name || '',
        owner_name: r.owner_name || '', owner_phone: r.owner_phone || '',
        owe, owe_property: round2(oweP), owe_network: round2(oweN)
      });
    }
  }
  out.sort((a, b) => b.owe - a.owe);
  return out;
}

/* 系统监控（仅超管）：三系统汇总 + 每主体明细 */
async function modeAggregate(p, mode) {
  const t = today(), ym = t.slice(0, 7);
  const [[rs]] = await p.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status='rented'),0) AS rented,
            COALESCE(SUM(status='vacant'),0) AS vacant, COALESCE(SUM(status='booked'),0) AS booked
       FROM rooms`);
  const [mb] = await p.query('SELECT amount, paid_amount FROM bills WHERE due_date LIKE ? OR period_start LIKE ?',
    [ym + '%', ym + '%']);
  const [ab] = await p.query('SELECT amount, paid_amount FROM bills');
  const [[rp]] = await p.query("SELECT COUNT(*) AS c FROM repairs WHERE status <> 'done'");
  const out = {
    total_rooms: Number(rs.total), rented: Number(rs.rented), vacant: Number(rs.vacant), booked: Number(rs.booked),
    occupancy: Number(rs.total) ? Math.round(Number(rs.rented) / Number(rs.total) * 100) : 0,
    month_receivable: round2(mb.reduce((s, b) => s + Number(b.amount), 0)),
    month_received: round2(mb.reduce((s, b) => s + Number(b.paid_amount || 0), 0)),
    arrears: round2(ab.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0)),
    pending_repairs: Number(rp.c), pending_complaints: 0
  };
  if (FEATURES[mode].complaint) {
    const [[cp]] = await p.query("SELECT COUNT(*) AS c FROM complaints WHERE status <> 'done'");
    out.pending_complaints = Number(cp.c);
  }
  return out;
}
router.get('/monitor', authMode, superOnly, h(async (req, res) => {
  const systems = {}, orgsByMode = { rental: [], hotel: [], property: [] };
  for (const m of MODES) {
    systems[m] = await modeAggregate(getPool(m), m);
  }
  const [orgs] = await shared.query('SELECT * FROM orgs ORDER BY mode, id');
  for (const o of orgs) {
    const p = getPool(o.mode);
    const agg = await modeAggregate(p, o.mode);
    const [[staff]] = await shared.query(
      "SELECT COUNT(*) AS c FROM users WHERE org_id = ? AND role <> 'admin'", [o.id]);
    const [[admin]] = await shared.query(
      "SELECT username, real_name FROM users WHERE org_id = ? AND role = 'admin' ORDER BY id LIMIT 1", [o.id]);
    orgsByMode[o.mode].push({
      id: o.id, name: o.name, admin_user_id: o.admin_user_id, admin: admin || null,
      staff_count: Number(staff.c), ...agg
    });
  }
  res.json({ time: nowStr(), dbs: 'ok', systems, orgs: orgsByMode });
}));

/* ==================================================================
 * 楼栋
 * ================================================================== */
router.get('/buildings', auth, h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, (SELECT COUNT(*) FROM rooms r WHERE r.building_id = b.id AND r.org_id = b.org_id) AS room_count
       FROM buildings b WHERE b.org_id = ? ORDER BY b.id`, [req.orgId]);
  res.json(rows);
}));
router.post('/buildings', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { required: true, max: 50 });
  const address = v.str('address', { max: 200 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [r] = await pool.query(
    'INSERT INTO buildings (org_id, name, address, remark) VALUES (?, ?, ?, ?)',
    [req.orgId, name, address || '', remark || '']);
  const [rows] = await pool.query('SELECT * FROM buildings WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json({ ...rows[0], room_count: 0 });
}));
router.put('/buildings/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { required: true, max: 50 });
  const address = v.str('address', { max: 200 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [r] = await pool.query(
    'UPDATE buildings SET name = ?, address = ?, remark = ? WHERE id = ? AND org_id = ?',
    [name, address || '', remark || '', req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '楼栋不存在' });
  const [rows] = await pool.query('SELECT * FROM buildings WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/buildings/:id', auth, h(async (req, res) => {
  const [[{ c }]] = await pool.query(
    'SELECT COUNT(*) AS c FROM rooms WHERE building_id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (Number(c) > 0) return res.status(400).json({ error: '该楼栋下还有房间，无法删除' });
  await pool.query('DELETE FROM buildings WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 房间 / 房产（字段按系统裁剪）
 * ================================================================== */
function roomSelectSql(mode) {
  if (mode === 'hotel') {
    return `SELECT r.*, b.name AS building_name,
        COALESCE((SELECT t.name FROM orders o JOIN tenants t ON t.id = o.guest_id
                   WHERE o.room_id = r.id AND o.status = 'checked_in' LIMIT 1),
                 (SELECT t.name FROM orders o JOIN tenants t ON t.id = o.guest_id
                   WHERE o.room_id = r.id AND o.status = 'booked' LIMIT 1), '') AS tenant_name,
        COALESCE((SELECT o.check_out_date FROM orders o WHERE o.room_id = r.id AND o.status = 'checked_in' LIMIT 1),
                 (SELECT o.check_in_date FROM orders o WHERE o.room_id = r.id AND o.status = 'booked' LIMIT 1),
                 NULL) AS end_date,
        NULL AS owner_name, NULL AS owner_phone
      FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id`;
  }
  if (mode === 'property') {
    return `SELECT r.*, b.name AS building_name, '' AS tenant_name, NULL AS end_date,
        (SELECT t.name FROM tenants t WHERE t.id = r.owner_id) AS owner_name,
        (SELECT t.phone FROM tenants t WHERE t.id = r.owner_id) AS owner_phone
      FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id`;
  }
  return `SELECT r.*, b.name AS building_name,
      (SELECT t.name FROM contracts c JOIN tenants t ON t.id = c.tenant_id
         WHERE c.room_id = r.id AND c.status = 'active' LIMIT 1) AS tenant_name,
      (SELECT c.end_date FROM contracts c WHERE c.room_id = r.id AND c.status = 'active' LIMIT 1) AS end_date,
      NULL AS owner_name, NULL AS owner_phone
    FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id`;
}
router.get('/rooms', auth, h(async (req, res) => {
  const { building_id, status, keyword } = req.query;
  const cond = ['r.org_id = ?'];
  const params = [req.orgId];
  if (building_id) { cond.push('r.building_id = ?'); params.push(Number(building_id)); }
  if (status) { cond.push('r.status = ?'); params.push(status); }
  if (keyword) { cond.push('r.room_no LIKE ?'); params.push('%' + keyword + '%'); }
  if (req.level === 'company_admin') { cond.push('r.owner_id = ?'); params.push(req.companyId); }
  const [rows] = await pool.query(
    roomSelectSql(req.mode) + ' WHERE ' + cond.join(' AND ') + ' ORDER BY r.id', params);
  res.json(rows);
}));
function roomPayload(B, mode) {
  const d = { org_id: currentOrgId(), remark: clean(B.remark || ''), room_no: clean(B.room_no),
    room_type: clean(B.room_type || ''), status: B.status || 'vacant' };
  for (const k of ROOM_FIELDS[mode]) {
    if (k === 'room_no' || k === 'room_type' || k === 'status' || k === 'remark') continue;
    d[k] = NUM_ROOM_FIELDS.includes(k) ? num(B[k]) : clean(B[k]);
  }
  return d;
}
const ROOM_STATUS = ['vacant', 'rented', 'booked', 'cleaning', 'maintenance'];
function roomRules(v, mode, partial) {
  if (partial) v.int('building_id', { min: 1, max: 1e7 });
  else v.int('building_id', { required: true, min: 1, max: 1e7 });
  v.str('room_no', partial ? { max: 50 } : { required: true, max: 50 });
  v.str('room_type', { max: 50 });
  v.str('status', { enum: ROOM_STATUS });
  v.str('remark', { max: 500 });
  v.num('floor', { min: -5, max: 500 });
  v.num('area', { min: 0, max: 1e6 });
  v.num('rent', { min: 0, max: 1e9 });
  v.num('deposit', { min: 0, max: 1e9 });
  v.num('day_price', { min: 0, max: 1e9 });
  v.num('property_fee', { min: 0, max: 1e9 });
  if (mode !== 'hotel') {
    v.num('water_price', { min: 0, max: 1e6 });
    v.num('elec_price', { min: 0, max: 1e6 });
  }
}
router.post('/rooms', auth, h(async (req, res) => {
  const B = req.body || {};
  const mode = req.mode;
  const v = V(B);
  roomRules(v, mode, false);
  v.ok();
  const d = roomPayload(B, mode);
  /* 企业管理员只能为本企业创建房产 */
  if (req.level === 'company_admin' && Number(d.owner_id) !== Number(req.companyId)) {
    return res.status(403).json({ error: '仅可为本企业创建房产' });
  }
  /* 水电单价：空值取本主体默认（仅租房/物业，且为新增时） */
  if (FEATURES[mode].settingsPrices) {
    const gp = await getOrgPrices();
    if (d.water_price === null || d.water_price === undefined) d.water_price = gp.water_price;
    if (d.elec_price === null || d.elec_price === undefined) d.elec_price = gp.elec_price;
  }
  const cols = Object.keys(d);
  const [r] = await pool.query(
    `INSERT INTO rooms (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map(c => d[c]));
  const [rows] = await pool.query(roomSelectSql(mode) + ' WHERE r.id = ? AND r.org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/rooms/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const mode = req.mode;
  const v = V(B);
  roomRules(v, mode, true);
  v.ok();
  const d = roomPayload(B, mode);
  delete d.org_id;
  /* 企业管理员只能编辑本企业房产，且归属企业不可改到别家 */
  if (req.level === 'company_admin') {
    const [[oldRoom]] = await pool.query('SELECT owner_id FROM rooms WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!oldRoom || Number(oldRoom.owner_id) !== Number(req.companyId)) {
      return res.status(403).json({ error: '仅可编辑本企业房产' });
    }
    if (d.owner_id !== undefined && Number(d.owner_id) !== Number(req.companyId)) {
      return res.status(403).json({ error: '房产归属企业不可变更' });
    }
  }
  const sets = Object.keys(d).map(c => `${c} = ?`).join(', ');
  const [r] = await pool.query(
    `UPDATE rooms SET ${sets} WHERE id = ? AND org_id = ?`,
    [...Object.keys(d).map(c => d[c]), req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '房间不存在' });
  const [rows] = await pool.query(roomSelectSql(mode) + ' WHERE r.id = ? AND r.org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/rooms/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const room = rows[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  if (!(await ownRoomCheck(req, room.id))) return res.status(403).json({ error: '仅可删除本企业房产' });
  if (room.status === 'rented' || room.status === 'booked') {
    return res.status(400).json({ error: '房间正在使用中，无法删除' });
  }
  if (FEATURES[req.mode].meter) await pool.query('DELETE FROM meters WHERE room_id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (FEATURES[req.mode].network) {
    await pool.query('DELETE FROM room_net_lines WHERE room_id = ? AND org_id = ?', [req.params.id, req.orgId]);
    await pool.query('DELETE FROM net_changes WHERE room_id = ? AND org_id = ?', [req.params.id, req.orgId]);
  }
  await pool.query('DELETE FROM rooms WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 租客 / 房客 / 企业（物业：tenants = 企业，无个人业主）
 * ================================================================== */
router.get('/tenants', auth, h(async (req, res) => {
  const { keyword } = req.query;
  let roomExpr;
  if (req.mode === 'hotel') {
    roomExpr = `(SELECT GROUP_CONCAT(CONCAT(b.name, ' ', r.room_no) SEPARATOR '、')
       FROM orders o JOIN rooms r ON r.id = o.room_id JOIN buildings b ON b.id = r.building_id
      WHERE o.guest_id = t.id AND o.status = 'checked_in' AND o.org_id = t.org_id) AS rooms`;
  } else if (req.mode === 'property') {
    roomExpr = `(SELECT GROUP_CONCAT(CONCAT(b.name, ' ', r.room_no) SEPARATOR '、')
       FROM rooms r JOIN buildings b ON b.id = r.building_id
      WHERE r.owner_id = t.id AND r.org_id = t.org_id) AS rooms`;
  } else {
    roomExpr = `(SELECT GROUP_CONCAT(CONCAT(b.name, ' ', r.room_no) SEPARATOR '、')
       FROM contracts c JOIN rooms r ON r.id = c.room_id JOIN buildings b ON b.id = r.building_id
      WHERE c.tenant_id = t.id AND c.status = 'active' AND c.org_id = t.org_id) AS rooms`;
  }
  const empExpr = req.mode === 'property'
    ? `(SELECT COUNT(*) FROM org_employees e WHERE e.owner_id = t.id AND e.org_id = t.org_id) AS emp_count`
    : `0 AS emp_count`;
  let sql = `SELECT t.*, ${roomExpr}, ${empExpr} FROM tenants t WHERE t.org_id = ?`;
  const params = [req.orgId];
  if (req.level === 'company_admin') { sql += ' AND t.id = ?'; params.push(req.companyId); }
  if (keyword) { sql += ' AND (t.name LIKE ? OR t.phone LIKE ?)'; params.push('%' + keyword + '%', '%' + keyword + '%'); }
  sql += ' ORDER BY t.id';
  const [rows] = await pool.query(sql, params);
  /* 企业管理员账号映射（users 在共享库，单独查询后合并） */
  let adminMap = {};
  if (req.mode === 'property' && rows.length) {
    const [aus] = await shared.query(
      'SELECT company_id, username FROM users WHERE org_id = ? AND company_id IS NOT NULL', [req.orgId]);
    adminMap = Object.fromEntries(aus.map(a => [a.company_id, a.username]));
  }
  res.json(rows.map(r => ({ ...r, emp_count: Number(r.emp_count),
    admin_username: adminMap[r.id] || null })));
}));
router.post('/tenants', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { required: true, max: 80 });
  const contact = v.str('contact', { max: 50 });
  const phone = v.str('phone', { max: 40 });
  const license_no = v.str('license_no', { max: 60 });
  const id_card = v.str('id_card', { max: 60 });
  const remark = v.str('remark', { max: 500 });
  const gender = v.str('gender', { enum: ['男', '女'], def: '男' });
  v.ok();
  if (req.mode === 'property') {
    /* 物业：企业（电话非必填） */
    const [r] = await pool.query(
      'INSERT INTO tenants (org_id, name, contact, phone, license_no, remark) VALUES (?, ?, ?, ?, ?, ?)',
      [req.orgId, name, contact || '', phone || '', license_no || '', remark || '']);
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
    return res.json({ ...rows[0], rooms: '', emp_count: 0 });
  }
  if (!phone) return res.status(400).json({ error: '姓名与联系电话不能为空' });
  const [r] = await pool.query(
    'INSERT INTO tenants (org_id, name, gender, phone, id_card, remark) VALUES (?, ?, ?, ?, ?, ?)',
    [req.orgId, name, gender, phone, id_card || '', remark || '']);
  const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json({ ...rows[0], rooms: '' });
}));
router.put('/tenants/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { required: true, max: 80 });
  const contact = v.str('contact', { max: 50 });
  const phone = v.str('phone', { max: 40 });
  const license_no = v.str('license_no', { max: 60 });
  const id_card = v.str('id_card', { max: 60 });
  const remark = v.str('remark', { max: 500 });
  const gender = v.str('gender', { enum: ['男', '女'], def: '男' });
  v.ok();
  if (req.mode === 'property') {
    const [r] = await pool.query(
      'UPDATE tenants SET name = ?, contact = ?, phone = ?, license_no = ?, remark = ? WHERE id = ? AND org_id = ?',
      [name, contact || '', phone || '', license_no || '', remark || '', req.params.id, req.orgId]);
    if (!r.affectedRows) return res.status(400).json({ error: '记录不存在' });
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    return res.json(rows[0]);
  }
  const [r] = await pool.query(
    'UPDATE tenants SET name = ?, gender = ?, phone = ?, id_card = ?, remark = ? WHERE id = ? AND org_id = ?',
    [name, gender, phone, id_card || '', remark || '', req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '记录不存在' });
  const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/tenants/:id', auth, h(async (req, res) => {
  const id = req.params.id, oid = req.orgId;
  if (FEATURES[req.mode].contract) {
    const [[{ c }]] = await pool.query(
      "SELECT COUNT(*) AS c FROM contracts WHERE tenant_id = ? AND org_id = ? AND status = 'active'", [id, oid]);
    if (Number(c) > 0) return res.status(400).json({ error: '该租客有履行中的合同，无法删除' });
  }
  if (FEATURES[req.mode].order) {
    const [[{ c }]] = await pool.query(
      "SELECT COUNT(*) AS c FROM orders WHERE guest_id = ? AND org_id = ? AND status IN ('booked','checked_in')", [id, oid]);
    if (Number(c) > 0) return res.status(400).json({ error: '该房客有未完成的订单，无法删除' });
  }
  if (FEATURES[req.mode].owner) {
    const [[{ c }]] = await pool.query(
      'SELECT COUNT(*) AS c FROM rooms WHERE owner_id = ? AND org_id = ?', [id, oid]);
    if (Number(c) > 0) return res.status(400).json({ error: '该企业名下仍有房产，请先解除绑定' });
    const [[{ c: ec }]] = await pool.query(
      'SELECT COUNT(*) AS c FROM org_employees WHERE owner_id = ? AND org_id = ?', [id, oid]);
    if (Number(ec) > 0) return res.status(400).json({ error: '该企业名下仍有企业员工，请先移除或改绑' });
  }
  /* 级联删除该企业的企业管理员账号，避免孤儿账号 */
  await shared.query('DELETE FROM users WHERE company_id = ? AND org_id = ?', [id, oid]);
  await pool.query('DELETE FROM tenants WHERE id = ? AND org_id = ?', [id, oid]);
  res.json({ ok: true });
}));

/* 企业管理员：主管理员为企业设置/重置账号（仅物业；企业管理员登录后只见本企业数据） */
router.post('/tenants/:id/company-admin', authMode, orgAdminOnly, h(async (req, res) => {
  if (req.mode !== 'property') return res.status(404).json({ error: '仅物业系统支持企业管理员' });
  const id = Number(req.params.id);
  const B = req.body || {};
  const v = V(B);
  const username = v.str('username', { required: true, max: 20, pattern: /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/ });
  const password = v.str('password', { required: true, max: 100, clean: false });
  const real_name = v.str('real_name', { max: 50 });
  v.ok();
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const [[comp]] = await pool.query('SELECT * FROM tenants WHERE id = ? AND org_id = ?', [id, req.orgId]);
  if (!comp) return res.status(400).json({ error: '企业不存在' });
  const dup = await shared.query(
    'SELECT id FROM users WHERE username = ? AND org_id = ? AND (company_id IS NULL OR company_id <> ?)', [username, req.orgId, id]);
  if (dup[0].length) return res.status(400).json({ error: '用户名已被使用' });
  const [exist] = await shared.query(
    'SELECT id FROM users WHERE company_id = ? AND org_id = ?', [id, req.orgId]);
  if (exist.length) {
    await shared.query('UPDATE users SET password = ?, real_name = ? WHERE id = ?',
      [hashPassword(password), real_name || '', exist[0].id]);
  } else {
    await shared.query(
      `INSERT INTO users (username, password, real_name, role, mode, org_id, company_id)
       VALUES (?, ?, ?, 'staff', 'property', ?, ?)`,
      [username, hashPassword(password), real_name || '', req.orgId, id]);
  }
  res.json({ ok: true, username });
}));

/* ==================================================================
 * 企业员工（仅物业：企业业主名下的员工档案；读需 org-emp 权限或主管理员，写仅主管理员）
 * ================================================================== */
router.get('/org-employees', authMode, h(async (req, res) => {
  if (req.mode !== 'property') return res.status(404).json({ error: '仅物业系统支持企业员工' });
  if (req.level !== 'admin' && req.level !== 'company_admin'
      && !(await userPerms(req.user.id)).pages.includes('orgemp')) {
    return res.status(403).json({ error: '无权限访问企业员工' });
  }
  const [rows] = await pool.query(
    `SELECT e.*, r.room_no, b.name AS building_name, t.name AS owner_name
       FROM org_employees e
       LEFT JOIN rooms r ON r.id = e.room_id
       LEFT JOIN buildings b ON b.id = r.building_id
       LEFT JOIN tenants t ON t.id = e.owner_id
      WHERE e.org_id = ?${req.level === 'company_admin' ? ' AND e.owner_id = ?' : ''} ORDER BY e.id`,
    req.level === 'company_admin' ? [req.orgId, req.companyId] : [req.orgId]);
  res.json(rows);
}));
router.post('/org-employees', authMode, orgAdminOnly, h(async (req, res) => {
  if (req.mode !== 'property') return res.status(404).json({ error: '仅物业系统支持企业员工' });
  const B = req.body || {};
  const v = V(B);
  const company = v.str('company', { required: true, max: 80 });
  const name = v.str('name', { required: true, max: 50 });
  const id_number = v.str('id_number', { max: 60 });
  const phone = v.str('phone', { max: 40 });
  const department = v.str('department', { max: 50 });
  const position = v.str('position', { max: 50 });
  const card_no = v.str('card_no', { max: 40 });
  const photo_url = v.str('photo_url', { max: 200 });
  const id_photo_url = v.str('id_photo_url', { max: 200 });
  const remark = v.str('remark', { max: 500 });
  const room_id = v.int('room_id', { min: 1, max: 1e7 });
  const owner_id = v.int('owner_id', { min: 1, max: 1e7 });
  v.ok();
  /* 自动匹配/创建企业（企业业主）记录，实现与业主绑定 */
  let ownerId = owner_id;
  if (!ownerId) {
    const [match] = await pool.query(
      'SELECT * FROM tenants WHERE org_id = ? AND name = ? LIMIT 1', [req.orgId, company]);
    ownerId = match.length ? match[0].id : (await pool.query(
      'INSERT INTO tenants (org_id, name) VALUES (?, ?)', [req.orgId, company]))[0].insertId;
  }
  const [r] = await pool.query(
    `INSERT INTO org_employees (org_id, company, owner_id, room_id, name, id_number, phone,
       department, position, card_no, photo_url, id_photo_url, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.orgId, company, ownerId, room_id || null, name,
     id_number || '', phone || '', department || '', position || '', card_no || '',
     photo_url || '', id_photo_url || '', remark || '']);
  const [rows] = await pool.query(
    `SELECT e.*, r.room_no, b.name AS building_name, t.name AS owner_name
       FROM org_employees e
       LEFT JOIN rooms r ON r.id = e.room_id LEFT JOIN buildings b ON b.id = r.building_id
       LEFT JOIN tenants t ON t.id = e.owner_id
      WHERE e.id = ?`, [r.insertId]);
  res.json(rows[0]);
}));
router.put('/org-employees/:id', authMode, orgAdminOnly, h(async (req, res) => {
  if (req.mode !== 'property') return res.status(404).json({ error: '仅物业系统支持企业员工' });
  const B = req.body || {};
  const v = V(B);
  const company = v.str('company', { required: true, max: 80 });
  const name = v.str('name', { required: true, max: 50 });
  const id_number = v.str('id_number', { max: 60 });
  const phone = v.str('phone', { max: 40 });
  const department = v.str('department', { max: 50 });
  const position = v.str('position', { max: 50 });
  const card_no = v.str('card_no', { max: 40 });
  const photo_url = v.str('photo_url', { max: 200 });
  const id_photo_url = v.str('id_photo_url', { max: 200 });
  const remark = v.str('remark', { max: 500 });
  const room_id = v.int('room_id', { min: 1, max: 1e7 });
  const owner_id = v.int('owner_id', { min: 1, max: 1e7 });
  v.ok();
  const [exist] = await pool.query('SELECT * FROM org_employees WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!exist.length) return res.status(400).json({ error: '记录不存在' });
  const [r] = await pool.query(
    `UPDATE org_employees SET company = ?, owner_id = ?, room_id = ?, name = ?, id_number = ?, phone = ?,
       department = ?, position = ?, card_no = ?, photo_url = ?, id_photo_url = ?, remark = ?
     WHERE id = ? AND org_id = ?`,
    [company, owner_id || null, room_id || null, name,
     id_number || '', phone || '', department || '', position || '', card_no || '',
     photo_url || '', id_photo_url || '', remark || '', req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '记录不存在' });
  const [rows] = await pool.query(
    `SELECT e.*, r.room_no, b.name AS building_name, t.name AS owner_name
       FROM org_employees e
       LEFT JOIN rooms r ON r.id = e.room_id LEFT JOIN buildings b ON b.id = r.building_id
       LEFT JOIN tenants t ON t.id = e.owner_id
      WHERE e.id = ?`, [req.params.id]);
  res.json(rows[0]);
}));
router.delete('/org-employees/:id', authMode, orgAdminOnly, h(async (req, res) => {
  if (req.mode !== 'property') return res.status(404).json({ error: '仅物业系统支持企业员工' });
  const [r] = await pool.query('DELETE FROM org_employees WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '记录不存在' });
  res.json({ ok: true });
}));

/* 图片上传（仅主管理员）：base64 → uploads/org-<主体ID>/，jpg/png/webp ≤2MB */
router.post('/upload', authMode, orgAdminOnly, h(async (req, res) => {
  const data = (req.body || {}).data;
  if (!data || typeof data !== 'string') return res.status(400).json({ error: '缺少图片数据' });
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(data);
  if (!m) return res.status(400).json({ error: '仅支持 jpg / png / webp 图片' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: '图片不能超过 2MB' });
  const dir = path.join(__dirname, '..', 'uploads', 'org-' + req.orgId);
  fs.mkdirSync(dir, { recursive: true });
  const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };
  const file = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + extMap[m[1]];
  fs.writeFileSync(path.join(dir, file), buf);
  res.json({ url: '/uploads/org-' + req.orgId + '/' + file });
}));

/* ==================================================================
 * 合同（租房）
 * ================================================================== */
router.get('/contracts', auth, h(async (req, res) => {
  await autoExpireContracts();
  const { status } = req.query;
  let sql = `SELECT c.*, r.room_no, b.name AS building_name, t.name AS tenant_name, t.phone AS tenant_phone
               FROM contracts c JOIN rooms r ON r.id = c.room_id
               JOIN buildings b ON b.id = r.building_id JOIN tenants t ON t.id = c.tenant_id
              WHERE c.org_id = ?`;
  const params = [req.orgId];
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  sql += ' ORDER BY c.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(c => ({ ...c, rent: Number(c.rent), deposit: Number(c.deposit), pay_cycle: Number(c.pay_cycle) })));
}));
router.post('/contracts', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const tenant_id = v.int('tenant_id', { required: true, min: 1, max: 1e7 });
  const start_date = v.date('start_date', { required: true });
  const end_date = v.date('end_date', { required: true });
  const rent = v.num('rent', { required: true, min: 0, max: 1e9 });
  const deposit = v.num('deposit', { min: 0, max: 1e9, def: 0 });
  const pay_cycle = v.num('pay_cycle', { min: 0.5, max: 36, def: 1 });
  const sign_date = v.date('sign_date', { def: today() });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [room_id, req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  if (room.status === 'rented') return res.status(400).json({ error: '该房间已出租' });
  const contract_no = 'HT' + Date.now().toString().slice(-8);
  const [r] = await pool.query(
    `INSERT INTO contracts (org_id, contract_no, room_id, tenant_id, start_date, end_date, rent, deposit,
        pay_cycle, sign_date, status, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [req.orgId, contract_no, room_id, tenant_id, start_date, end_date,
     rent, deposit, pay_cycle, sign_date || today(), remark || '']);
  await pool.query("UPDATE rooms SET status = 'rented' WHERE id = ? AND org_id = ?", [room.id, req.orgId]);
  const [rows] = await pool.query('SELECT * FROM contracts WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json({ ...rows[0], rent: Number(rows[0].rent), deposit: Number(rows[0].deposit) });
}));
router.put('/contracts/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const tenant_id = v.int('tenant_id', { required: true, min: 1, max: 1e7 });
  const start_date = v.date('start_date', { required: true });
  const end_date = v.date('end_date', { required: true });
  const rent = v.num('rent', { required: true, min: 0, max: 1e9 });
  const deposit = v.num('deposit', { min: 0, max: 1e9, def: 0 });
  const pay_cycle = v.num('pay_cycle', { min: 0.5, max: 36, def: 1 });
  const sign_date = v.date('sign_date', { def: today() });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [r] = await pool.query(
    `UPDATE contracts SET room_id = ?, tenant_id = ?, start_date = ?, end_date = ?, rent = ?,
            deposit = ?, pay_cycle = ?, sign_date = ?, remark = ? WHERE id = ? AND org_id = ?`,
    [room_id, tenant_id, start_date, end_date, rent,
     deposit, pay_cycle, sign_date || today(), remark || '',
     req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '合同不存在' });
  const [rows] = await pool.query('SELECT * FROM contracts WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ...rows[0], rent: Number(rows[0].rent), deposit: Number(rows[0].deposit) });
}));
router.post('/contracts/:id/terminate', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM contracts WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const c = rows[0];
  if (!c) return res.status(400).json({ error: '合同不存在' });
  await pool.query("UPDATE contracts SET status = 'terminated' WHERE id = ? AND org_id = ?", [c.id, req.orgId]);
  await pool.query("UPDATE rooms SET status = 'vacant' WHERE id = ? AND org_id = ? AND status = 'rented'", [c.room_id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM contracts WHERE id = ? AND org_id = ?', [c.id, req.orgId]);
  res.json(after[0]);
}));

/* ==================================================================
 * 订单（酒店）
 * ================================================================== */
const normOrder = o => ({ ...o, days: Number(o.days), day_price: Number(o.day_price),
  total: Number(o.total), deposit: Number(o.deposit) });
router.get('/orders', auth, h(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT o.*, r.room_no, b.name AS building_name, t.name AS guest_name, t.phone AS guest_phone
               FROM orders o JOIN rooms r ON r.id = o.room_id
               JOIN buildings b ON b.id = r.building_id JOIN tenants t ON t.id = o.guest_id
              WHERE o.org_id = ?`;
  const params = [req.orgId];
  if (status) { sql += ' AND o.status = ?'; params.push(status); }
  sql += ' ORDER BY o.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(normOrder));
}));
router.post('/orders', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const guest_id = v.int('guest_id', { required: true, min: 1, max: 1e7 });
  const check_in_date = v.date('check_in_date', { required: true });
  const check_out_date = v.date('check_out_date', { required: true });
  const day_price = v.num('day_price', { required: true, min: 0, max: 1e9 });
  const deposit = v.num('deposit', { min: 0, max: 1e9, def: 0 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [room_id, req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  const days = daysBetween(check_in_date, check_out_date);
  const total = days * day_price;
  const [r] = await pool.query(
    `INSERT INTO orders (org_id, order_no, room_id, guest_id, check_in_date, check_out_date, days, day_price,
        total, deposit, status, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
    [req.orgId, 'DD' + Date.now().toString().slice(-8), room_id, guest_id,
     check_in_date, check_out_date, days, day_price, total, deposit, remark || '', nowStr()]);
  if (room.status === 'vacant') {
    await pool.query("UPDATE rooms SET status = 'booked' WHERE id = ? AND org_id = ?", [room.id, req.orgId]);
  }
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(normOrder(rows[0]));
}));
router.put('/orders/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const guest_id = v.int('guest_id', { required: true, min: 1, max: 1e7 });
  const check_in_date = v.date('check_in_date', { required: true });
  const check_out_date = v.date('check_out_date', { required: true });
  const day_price = v.num('day_price', { required: true, min: 0, max: 1e9 });
  const deposit = v.num('deposit', { min: 0, max: 1e9, def: 0 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [os] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!os.length) return res.status(400).json({ error: '订单不存在' });
  const days = daysBetween(check_in_date, check_out_date);
  await pool.query(
    `UPDATE orders SET room_id = ?, guest_id = ?, check_in_date = ?, check_out_date = ?, days = ?,
            day_price = ?, total = ?, deposit = ?, remark = ? WHERE id = ? AND org_id = ?`,
    [room_id, guest_id, check_in_date, check_out_date, days, day_price,
     days * day_price, deposit, remark || '', req.params.id, req.orgId]);
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(normOrder(rows[0]));
}));
router.post('/orders/:id/checkin', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const o = rows[0];
  if (!o) return res.status(400).json({ error: '订单不存在' });
  if (o.status !== 'booked') return res.status(400).json({ error: '只有已预订订单可以办理入住' });
  await pool.query("UPDATE orders SET status = 'checked_in', checkin_time = ? WHERE id = ? AND org_id = ?",
    [nowStr(), o.id, req.orgId]);
  await pool.query("UPDATE rooms SET status = 'rented' WHERE id = ? AND org_id = ?", [o.room_id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [o.id, req.orgId]);
  res.json(normOrder(after[0]));
}));
router.post('/orders/:id/checkout', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const o = rows[0];
  if (!o) return res.status(400).json({ error: '订单不存在' });
  if (o.status !== 'checked_in') return res.status(400).json({ error: '只有已入住订单可以办理退房' });
  await pool.query("UPDATE orders SET status = 'checked_out', checkout_time = ? WHERE id = ? AND org_id = ?",
    [nowStr(), o.id, req.orgId]);
  await pool.query("UPDATE rooms SET status = 'cleaning' WHERE id = ? AND org_id = ?", [o.room_id, req.orgId]);
  const [[bc]] = await pool.query('SELECT COUNT(*) AS c FROM bills WHERE order_id = ? AND org_id = ?', [o.id, req.orgId]);
  if (Number(bc.c) === 0) {
    await pool.query(
      `INSERT INTO bills (org_id, source, room_id, tenant_id, order_id, period_start, period_end, due_date,
          amount, paid_amount, status, remark)
       VALUES (?, 'hotel', ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
      [req.orgId, o.room_id, o.guest_id, o.id, o.check_in_date, o.check_out_date, today(),
       Number(o.total), '订单 ' + o.order_no + ' 房费']);
  }
  const [after] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [o.id, req.orgId]);
  res.json(normOrder(after[0]));
}));
router.post('/orders/:id/cancel', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const o = rows[0];
  if (!o) return res.status(400).json({ error: '订单不存在' });
  await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = ? AND org_id = ?", [o.id, req.orgId]);
  await pool.query("UPDATE rooms SET status = 'vacant' WHERE id = ? AND org_id = ? AND status = 'booked'",
    [o.room_id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [o.id, req.orgId]);
  res.json(normOrder(after[0]));
}));
router.delete('/orders/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const o = rows[0];
  if (!o) return res.status(400).json({ error: '订单不存在' });
  if (o.status === 'checked_in') return res.status(400).json({ error: '客人仍在住，无法删除订单' });
  await pool.query('DELETE FROM orders WHERE id = ? AND org_id = ?', [o.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 账单
 * ================================================================== */
const normBill = b => ({ ...b, amount: Number(b.amount), paid_amount: Number(b.paid_amount),
  items: b.items ? parseBillItems(b.items) : null });
function parseBillItems(raw){
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string'){ try { const a = JSON.parse(raw); return Array.isArray(a) ? a : null; } catch { return null; } }
  return null;
}
router.get('/bills', auth, h(async (req, res) => {
  const { status, source } = req.query;
  const cond = ['b.org_id = ?'];
  const params = [req.orgId];
  if (status) { cond.push('b.status = ?'); params.push(status); }
  if (source) { cond.push('b.source = ?'); params.push(source); }
  if (req.level === 'company_admin') { cond.push('r.owner_id = ?'); params.push(req.companyId); }
  const [rows] = await pool.query(
    `SELECT b.*, r.room_no, bd.name AS building_name, t.name AS tenant_name
       FROM bills b LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN buildings bd ON bd.id = r.building_id LEFT JOIN tenants t ON t.id = b.tenant_id
      WHERE ${cond.join(' AND ')} ORDER BY b.id DESC`, params);
  res.json(rows.map(normBill));
}));

/* 账单生成（按系统） */
router.post('/bills/generate', auth, h(async (req, res) => {
  const mode = req.mode, f = FEATURES[mode];
  const v = V(req.body || {});
  const kind = v.str('kind', { enum: ['all', 'rental', 'hotel', 'property', 'utility', 'network'], def: 'all' });
  const room_id = v.int('room_id', { min: 1, max: 1e7 });
  v.ok();
  const roomId = room_id;
  const oid = req.orgId;
  const t = today(), ym = t.slice(0, 7);
  const start = monthStart(t), end = addDays(addMonths(start, 1), -1);
  let n = 0, skipped = 0, skippedReasons = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    /* 租房：合同分期租金 */
    if (f.contract && (kind === 'all' || kind === 'rental')) {
      const [contracts] = await conn.query("SELECT * FROM contracts WHERE org_id = ? AND status = 'active'", [oid]);
      for (const c of contracts) {
        const [bs] = await conn.query(
          'SELECT period_end FROM bills WHERE org_id = ? AND contract_id = ? ORDER BY period_end DESC LIMIT 1',
          [oid, c.id]);
        const last = bs[0];
        const s = last ? addDays(last.period_end, 1) : c.start_date;
        if (s > t || s > c.end_date) { skipped++; continue; }
        const months = Number(c.pay_cycle) || 1;
        let e = addDays(addMonths(s, months), -1);
        if (e > c.end_date) e = c.end_date;
        await conn.query(
          `INSERT INTO bills (org_id, source, room_id, tenant_id, contract_id, period_start, period_end, due_date,
              amount, paid_amount, status, remark)
           VALUES (?, 'rental', ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
          [oid, c.room_id, c.tenant_id, c.id, s, e, s, Number(c.rent) * months, '合同 ' + c.contract_no]);
        n++;
      }
    }

    /* 酒店：退房未结算订单 */
    if (f.order && (kind === 'all' || kind === 'hotel')) {
      const [outs] = await conn.query(
        `SELECT o.* FROM orders o LEFT JOIN bills b ON b.order_id = o.id AND b.org_id = o.org_id
          WHERE o.org_id = ? AND o.status = 'checked_out' AND b.id IS NULL`, [oid]);
      for (const o of outs) {
        await conn.query(
          `INSERT INTO bills (org_id, source, room_id, tenant_id, order_id, period_start, period_end, due_date,
              amount, paid_amount, status, remark)
           VALUES (?, 'hotel', ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
          [oid, o.room_id, o.guest_id, o.id, o.check_in_date, o.check_out_date, o.check_out_date,
           Number(o.total), '订单 ' + o.order_no]);
        n++;
      }
    }

    /* 水电：物业（物业费+水电）一张单；租房（仅水电）一张单 */
    if (f.meter && (mode === 'property' ? (kind === 'all' || kind === 'property') : (kind === 'all' || kind === 'utility'))) {
      const [rooms] = await conn.query(
        `SELECT * FROM rooms WHERE org_id = ? ${roomId ? 'AND id = ?' : ''} AND ${f.billable}`,
        roomId ? [oid, roomId] : [oid]);
      for (const r of rooms) {
        const src = mode === 'property' ? 'property' : 'utility';
        const [[{ c }]] = await conn.query(
          'SELECT COUNT(*) AS c FROM bills WHERE org_id = ? AND source = ? AND room_id = ? AND period_start LIKE ?',
          [oid, src, r.id, ym + '%']);
        if (Number(c) > 0) { skipped++; continue; }
        const bd = await billBreakdown(conn, r, ym);
        if (bd.total <= 0) { skipped++; continue; }
        const detail = [
          bd.property_fee > 0 ? `物业费 ¥${bd.property_fee.toFixed(2)}` : '',
          bd.water_fee > 0 ? `水费 ¥${bd.water_fee.toFixed(2)}` : '',
          bd.elec_fee > 0 ? `电费 ¥${bd.elec_fee.toFixed(2)}` : ''
        ].filter(Boolean).join(' + ');
        await conn.query(
          `INSERT INTO bills (org_id, source, room_id, tenant_id, period_start, period_end, due_date,
              amount, paid_amount, status, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
          [oid, src, r.id, mode === 'property' ? r.owner_id : await rentedTenant(conn, r.id, oid),
           start, end, ym + '-10', bd.total, '明细：' + (detail || '费用')]);
        n++;
      }
    }

    /* 网费（租房/物业） */
    if (f.network && (kind === 'all' || kind === 'network')) {
      const [rooms] = await conn.query(
        `SELECT * FROM rooms WHERE org_id = ? ${roomId ? 'AND id = ?' : ''} AND ${f.billable}`,
        roomId ? [oid, roomId] : [oid]);
      for (const r of rooms) {
        const [[{ c }]] = await conn.query(
          "SELECT COUNT(*) AS c FROM bills WHERE org_id = ? AND source = 'network' AND room_id = ? AND period_start LIKE ?",
          [oid, r.id, ym + '%']);
        if (Number(c) > 0) { skippedReasons.push({ room: '房间 ' + (r.room_no || r.id), reason: '已有账单' }); skipped++; continue; }
        const calc = await calcNetFee(conn, r.id, ym);
        if (calc.total <= 0) { skippedReasons.push({ room: '房间 ' + (r.room_no || r.id), reason: '带宽为 0 无网费' }); skipped++; continue; }
        const detail = calc.lines.map(l => {
          const segTxt = l.segments.map(s =>
            `${s.bandwidth}兆×${s.days}天`).join(' + ');
          return `【${l.line_name}】${segTxt}`;
        }).join(' ');
        const tenant = mode === 'property' ? r.owner_id : await rentedTenant(conn, r.id, oid);
        const [st0] = await shared.query('SELECT currency, rate FROM settings WHERE org_id = ?', [oid]);
        const isUsd = st0[0] && st0[0].currency === 'USD';
        const rate0 = st0[0] && Number(st0[0].rate) > 0 ? Number(st0[0].rate) : 7.2;
        const unit = calc.lines[0] ? Number(calc.lines[0].price) || 0 : 0;
        const unitTxt = (isUsd ? '$' : '¥') + (isUsd ? (unit / rate0).toFixed(2) : unit.toFixed(2));
        await conn.query(
          `INSERT INTO bills (org_id, source, room_id, tenant_id, period_start, period_end, due_date,
              amount, paid_amount, status, remark)
           VALUES (?, 'network', ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
          [oid, r.id, tenant, start, end, ym + '-10', calc.total,
           `网费：${detail}（按 ${calc.daysInMonth} 天折算，单价 ${unitTxt}/兆）`]);
        n++;
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const label = { all: '全部', rental: '租金', hotel: '酒店', property: '物业', utility: '水电', network: '网费' }[kind] || kind;
  if (!n) return res.json({
    msg: `没有需要生成的账单${skipped ? `（${skipped} 项已存在或不满足条件）` : ''}`,
    detail: skippedReasons
  });
  return res.json({ msg: `本次共生成 ${n} 条${label}账单${skipped ? `，跳过 ${skipped} 项` : ''}`, detail: skippedReasons });
}));

/* 更新网费账单：按当前带宽/单价重算当月未收款账单（保留账单 ID），已收款禁止更新 */
router.post('/bills/update-network', auth, h(async (req, res) => {
  const v = V(req.body || {});
  const room_id = v.int('room_id', { min: 1, max: 1e7 });
  v.ok();
  const oid = req.orgId;
  const t = today(), ym = t.slice(0, 7);
  const end = addDays(addMonths(monthStart(t), 1), -1);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [bills] = await conn.query(
      "SELECT * FROM bills WHERE org_id = ? AND source = 'network' AND room_id = ? AND period_start LIKE ?",
      [oid, room_id, ym + '%']);
    const bill = bills[0];
    if (!bill) {
      await conn.rollback(); conn.release();
      return res.json({ msg: '该房间当月没有网费账单，请先「生成账单」' });
    }
    if (bill.status === 'paid') {
      await conn.rollback(); conn.release();
      return res.status(403).json({ msg: '该账单已收款，不能更新（避免破坏财务记录）' });
    }
    const calc = await calcNetFee(conn, room_id, ym);
    if (calc.total <= 0) {
      /* 带宽为 0：无网费，删除原账单 */
      await conn.query('DELETE FROM bills WHERE id = ? AND org_id = ?', [bill.id, oid]);
      await conn.commit(); conn.release();
      return res.json({ msg: '当前带宽为 0，无网费，已删除原账单，需要时可重新生成' });
    }
    const detail = calc.lines.map(l => {
      const segTxt = l.segments.map(s => `${s.bandwidth}兆×${s.days}天`).join(' + ');
      return `【${l.line_name}】${segTxt}`;
    }).join(' ');
    const [st0] = await shared.query('SELECT currency, rate FROM settings WHERE org_id = ?', [oid]);
    const isUsd = st0[0] && st0[0].currency === 'USD';
    const rate0 = st0[0] && Number(st0[0].rate) > 0 ? Number(st0[0].rate) : 7.2;
    const unit = calc.lines[0] ? Number(calc.lines[0].price) || 0 : 0;
    const unitTxt = (isUsd ? '$' : '¥') + (isUsd ? (unit / rate0).toFixed(2) : unit.toFixed(2));
    await conn.query(
      `UPDATE bills SET amount = ?, remark = ?, period_end = ? WHERE id = ? AND org_id = ?`,
      [calc.total, `网费：${detail}（按 ${calc.daysInMonth} 天折算，单价 ${unitTxt}/兆）`, end, bill.id, oid]);
    await conn.commit(); conn.release();
    return res.json({ msg: `已更新账单 #${bill.id}：金额由 ${bill.amount} 重算为 ${calc.total}`, amount: calc.total });
  } catch (e) {
    await conn.rollback();
    conn.release();
    throw e;
  }
}));
/* 租房：某房间生效合同的租客 id */
async function rentedTenant(conn, roomId, oid) {
  const [cs] = await conn.query(
    "SELECT tenant_id FROM contracts WHERE room_id = ? AND org_id = ? AND status = 'active' LIMIT 1", [roomId, oid]);
  return cs[0] ? cs[0].tenant_id : null;
}

router.post('/bills', auth, h(async (req, res) => {
  const B = req.body || {};
  const allowed = { rental: ['rental', 'utility', 'network', 'net_repair', 'install', 'repair', 'other'],
    hotel: ['hotel'],
    property: ['property', 'utility', 'network', 'net_repair', 'install', 'repair', 'other'] };
  const v = V(B);
  const source = v.str('source', { enum: allowed[req.mode], def: allowed[req.mode][0] });
  const room_id = v.int('room_id', { min: 1, max: 1e7 });
  const tenant_id = v.int('tenant_id', { min: 1, max: 1e7 });
  const contract_id = v.int('contract_id', { min: 1, max: 1e7 });
  const order_id = v.int('order_id', { min: 1, max: 1e7 });
  const period_start = v.date('period_start', { required: true });
  const period_end = v.date('period_end', { required: true });
  const due_date = v.date('due_date', { def: today() });
  const amount = v.num('amount', { required: true, min: 0, max: 1e12 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  if (!(await ownRoomCheck(req, room_id))) return res.status(403).json({ error: '仅可为本企业房产添加账单' });
  /* 维修/安装类账单明细：{name, qty, price}，qty/price 同时为空表示说明行（不计金额）；
   * 提供明细时账单金额以后端按 数量×单价 合计为准，防止手算误差 */
  let items = null;
  if (B.items !== undefined && B.items !== null) {
    if (!Array.isArray(B.items)) return res.status(400).json({ error: '明细格式不正确' });
    if (B.items.length > 50) return res.status(400).json({ error: '明细不能超过 50 行' });
    items = [];
    for (const it of B.items) {
      if (!it || typeof it !== 'object' || typeof it.name !== 'string' || !it.name.trim()) {
        return res.status(400).json({ error: '明细项目名称不能为空' });
      }
      if (it.name.trim().length > 100) return res.status(400).json({ error: '明细项目名称不能超过 100 字' });
      if (it.model !== undefined && it.model !== null && it.model !== '' &&
          (typeof it.model !== 'string' || it.model.trim().length > 100)) {
        return res.status(400).json({ error: '明细型号不能超过 100 字' });
      }
      const qty = (it.qty === null || it.qty === undefined || it.qty === '') ? null : Number(it.qty);
      const price = (it.price === null || it.price === undefined || it.price === '') ? null : Number(it.price);
      if (qty !== null && (!Number.isInteger(qty) || qty < 1 || qty > 999999)) {
        return res.status(400).json({ error: '明细数量必须为正整数' });
      }
      if (price !== null && (!Number.isFinite(price) || price < 0 || price > 999999.99)) {
        return res.status(400).json({ error: '明细单价不正确' });
      }
      if (qty === null && price !== null) return res.status(400).json({ error: '明细数量不能为空' });
      if (qty !== null && price === null) return res.status(400).json({ error: '明细单价不能为空' });
      items.push({ name: it.name.trim(), model: it.model !== undefined && it.model !== null && it.model !== '' ? String(it.model).trim() : null, qty, price });
    }
  }
  const total = items ? round2(items.reduce((s, it) => s + ((Number(it.qty) || 0) * (Number(it.price) || 0)), 0)) : amount;
  const [r] = await pool.query(
    `INSERT INTO bills (org_id, source, room_id, tenant_id, contract_id, order_id, period_start, period_end,
        due_date, amount, paid_amount, status, remark, items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?, ?)`,
    [req.orgId, source, room_id || null, tenant_id || null,
     contract_id || null, order_id || null,
     period_start, period_end, due_date || today(), total, remark || '手动添加',
     items ? JSON.stringify(items) : null]);
  const [rows] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(normBill(rows[0]));
}));
router.post('/bills/:id/pay', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const amt = v.num('amount', { required: true, min: 0, max: 1e12 });
  const pay_date = v.date('pay_date', { def: today() });
  const pay_method = v.str('pay_method', { max: 30 });
  v.ok();
  const [rows] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const b = rows[0];
  if (!b) return res.status(400).json({ error: '账单不存在' });
  if (!(await ownRoomCheck(req, b.room_id))) return res.status(403).json({ error: '仅可操作本企业房产的账单' });
  const paid = Math.min(Number(b.amount), Number(b.paid_amount) + amt);
  const status = paid >= Number(b.amount) ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  await pool.query(
    `UPDATE bills SET paid_amount = ?, status = ?, pay_method = COALESCE(?, pay_method), pay_date = ?
      WHERE id = ? AND org_id = ?`,
    [paid, status, pay_method || null, pay_date, b.id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [b.id, req.orgId]);
  res.json(normBill(after[0]));
}));
router.delete('/bills/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const b = rows[0];
  if (!b) return res.status(400).json({ error: '账单不存在' });
  if (!(await ownRoomCheck(req, b.room_id))) return res.status(403).json({ error: '仅可删除本企业房产的账单' });
  await pool.query('DELETE FROM bills WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 水电抄表（租房 / 物业）
 * ================================================================== */
router.get('/meters', auth, h(async (req, res) => {
  const { month, room_id, building_id } = req.query;
  const personJoin = req.mode === 'property'
    ? 'LEFT JOIN tenants t ON t.id = r.owner_id'
    : `LEFT JOIN contracts c ON c.room_id = r.id AND c.status = 'active'
       LEFT JOIN tenants t ON t.id = c.tenant_id`;
  const personCols = req.mode === 'property'
    ? 't.name AS owner_name, t.phone AS owner_phone,'
    : 't.name AS owner_name, t.phone AS owner_phone,';
  let sql = `SELECT m.*, r.room_no, b.name AS building_name, ${personCols} r.water_price, r.elec_price
               FROM meters m JOIN rooms r ON r.id = m.room_id
               JOIN buildings b ON b.id = r.building_id ${personJoin}
              WHERE m.org_id = ?`;
  const params = [req.orgId];
  if (month) { sql += ' AND m.month = ?'; params.push(month); }
  if (room_id) { sql += ' AND m.room_id = ?'; params.push(Number(room_id)); }
  if (building_id) { sql += ' AND r.building_id = ?'; params.push(Number(building_id)); }
  if (req.level === 'company_admin') { sql += ' AND r.owner_id = ?'; params.push(req.companyId); }
  sql += ' ORDER BY m.month DESC, m.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));
async function meterPayload(B, room) {
  const wu = Math.max(0, Number(B.water_curr || 0) - Number(B.water_prev || 0));
  const eu = Math.max(0, Number(B.elec_curr || 0) - Number(B.elec_prev || 0));
  return {
    room_id: Number(B.room_id), month: B.month,
    water_prev: Number(B.water_prev) || 0, water_curr: Number(B.water_curr) || 0, water_usage: wu,
    water_fee: round2(wu * (Number(room.water_price) || 0)),
    elec_prev: Number(B.elec_prev) || 0, elec_curr: Number(B.elec_curr) || 0, elec_usage: eu,
    elec_fee: round2(eu * (Number(room.elec_price) || 0)),
    remark: B.remark || ''
  };
}
const normMeter = m => ({ ...m,
  water_prev: Number(m.water_prev), water_curr: Number(m.water_curr), water_usage: Number(m.water_usage),
  water_fee: Number(m.water_fee), elec_prev: Number(m.elec_prev), elec_curr: Number(m.elec_curr),
  elec_usage: Number(m.elec_usage), elec_fee: Number(m.elec_fee) });
router.post('/meters', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const month = v.date('month', { required: true });
  const water_prev = v.num('water_prev', { min: 0, max: 1e12, def: 0 });
  const water_curr = v.num('water_curr', { min: 0, max: 1e12, def: 0 });
  const elec_prev = v.num('elec_prev', { min: 0, max: 1e12, def: 0 });
  const elec_curr = v.num('elec_curr', { min: 0, max: 1e12, def: 0 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  B.room_id = room_id; B.month = month; B.water_prev = water_prev; B.water_curr = water_curr;
  B.elec_prev = elec_prev; B.elec_curr = elec_curr; B.remark = remark;
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [room_id, req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  if (!(await ownRoomCheck(req, room_id))) return res.status(403).json({ error: '仅可录入本企业房产的抄表' });
  const [[{ c }]] = await pool.query(
    'SELECT COUNT(*) AS c FROM meters WHERE room_id = ? AND org_id = ? AND month = ?',
    [room_id, req.orgId, month]);
  if (Number(c) > 0) return res.status(400).json({ error: '该房间本月已存在抄表记录，请直接编辑。' });
  const d = await meterPayload(B, room);
  const [r] = await pool.query(
    `INSERT INTO meters (org_id, room_id, month, water_prev, water_curr, water_usage, water_fee,
        elec_prev, elec_curr, elec_usage, elec_fee, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.orgId, d.room_id, d.month, d.water_prev, d.water_curr, d.water_usage, d.water_fee,
     d.elec_prev, d.elec_curr, d.elec_usage, d.elec_fee, d.remark]);
  const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(normMeter(rows[0]));
}));
router.put('/meters/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const month = v.date('month', { required: true });
  const water_prev = v.num('water_prev', { min: 0, max: 1e12, def: 0 });
  const water_curr = v.num('water_curr', { min: 0, max: 1e12, def: 0 });
  const elec_prev = v.num('elec_prev', { min: 0, max: 1e12, def: 0 });
  const elec_curr = v.num('elec_curr', { min: 0, max: 1e12, def: 0 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  B.room_id = room_id; B.month = month; B.water_prev = water_prev; B.water_curr = water_curr;
  B.elec_prev = elec_prev; B.elec_curr = elec_curr; B.remark = remark;
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [room_id, req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  if (!(await ownRoomCheck(req, room_id))) return res.status(403).json({ error: '仅可编辑本企业房产的抄表' });
  const [[mOld]] = await pool.query('SELECT room_id FROM meters WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!mOld) return res.status(400).json({ error: '抄表记录不存在' });
  if (!(await ownRoomCheck(req, mOld.room_id))) return res.status(403).json({ error: '仅可编辑本企业房产的抄表' });
  const [[{ c }]] = await pool.query(
    'SELECT COUNT(*) AS c FROM meters WHERE room_id = ? AND org_id = ? AND month = ? AND id <> ?',
    [room_id, req.orgId, month, req.params.id]);
  if (Number(c) > 0) return res.status(400).json({ error: '该房间本月已存在抄表记录，请直接编辑。' });
  const d = await meterPayload(B, room);
  const [r] = await pool.query(
    `UPDATE meters SET room_id = ?, month = ?, water_prev = ?, water_curr = ?, water_usage = ?, water_fee = ?,
        elec_prev = ?, elec_curr = ?, elec_usage = ?, elec_fee = ?, remark = ?
      WHERE id = ? AND org_id = ?`,
    [d.room_id, d.month, d.water_prev, d.water_curr, d.water_usage, d.water_fee,
     d.elec_prev, d.elec_curr, d.elec_usage, d.elec_fee, d.remark, req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '抄表记录不存在' });
  const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(normMeter(rows[0]));
}));
router.delete('/meters/:id', auth, h(async (req, res) => {
  const [[mOld]] = await pool.query('SELECT room_id FROM meters WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (mOld && !(await ownRoomCheck(req, mOld.room_id))) return res.status(403).json({ error: '仅可删除本企业房产的抄表' });
  await pool.query('DELETE FROM meters WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 带宽变更（租房 / 物业）
 * ================================================================== */
/* 宽带线路（租房/物业）：一个房间可开通多条，单价统一取主体设置 */
router.get('/netLines', auth, h(async (req, res) => {
  const { room_id } = req.query;
  let sql = `SELECT l.*, r.room_no, b.name AS building_name
               FROM room_net_lines l JOIN rooms r ON r.id = l.room_id
               JOIN buildings b ON b.id = r.building_id WHERE l.org_id = ?`;
  const params = [req.orgId];
  if (room_id) { sql += ' AND l.room_id = ?'; params.push(Number(room_id)); }
  if (req.level === 'company_admin') { sql += ' AND r.owner_id = ?'; params.push(req.companyId); }
  sql += ' ORDER BY l.room_id, l.id';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(l => ({ ...l, bandwidth: Number(l.bandwidth) || 0 })));
}));
router.post('/netLines', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const bandwidth = v.num('bandwidth', { required: true, min: 1, max: 1e6 });
  const line_name = v.str('line_name', { max: 50, def: '默认线路' });
  const start_date = v.date('start_date', { def: today() });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [room_id, req.orgId]);
  if (!rooms[0]) return res.status(400).json({ error: '房间不存在' });
  if (!(await ownRoomCheck(req, room_id))) return res.status(403).json({ error: '仅可为本企业房产新增线路' });
  const [r] = await pool.query(
    `INSERT INTO room_net_lines (org_id, room_id, line_name, bandwidth, start_date, status, stop_date, remark, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    [req.orgId, room_id, line_name || '默认线路', bandwidth, start_date, remark || '', nowStr()]);
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/netLines/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const line_name = v.str('line_name', { max: 50 });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!rows[0]) return res.status(400).json({ error: '线路不存在' });
  const line = rows[0];
  if (!(await ownRoomCheck(req, line.room_id))) return res.status(403).json({ error: '仅可编辑本企业房产的线路' });
  const sets = [];
  const params = [];
  if (line_name !== null) { sets.push('line_name = ?'); params.push(line_name || line.line_name); }
  if (remark !== null) { sets.push('remark = ?'); params.push(remark || ''); }
  if (sets.length) {
    await pool.query(`UPDATE room_net_lines SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`,
      [...params, req.params.id, req.orgId]);
  }
  const [after] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(after[0]);
}));
router.post('/netLines/:id/stop', auth, h(async (req, res) => {
  const v = V(req.body || {});
  const stopDate = v.date('stop_date', { def: today() });
  v.ok();
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const line = rows[0];
  if (!line) return res.status(400).json({ error: '线路不存在' });
  if (!(await ownRoomCheck(req, line.room_id))) return res.status(403).json({ error: '仅可停用本企业房产的线路' });
  if (line.status === 'stopped') return res.status(400).json({ error: '线路已停用' });
  if (line.start_date && stopDate < String(line.start_date)) {
    return res.status(400).json({ error: '停用日期不能早于开通日' });
  }
  await pool.query(
    "UPDATE room_net_lines SET status = 'stopped', stop_date = ? WHERE id = ? AND org_id = ?",
    [stopDate, req.params.id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(after[0]);
}));
router.post('/netLines/:id/start', auth, h(async (req, res) => {
  const v = V(req.body || {});
  const startDate = v.date('start_date', { def: today() });
  v.ok();
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const line = rows[0];
  if (!line) return res.status(400).json({ error: '线路不存在' });
  if (!(await ownRoomCheck(req, line.room_id))) return res.status(403).json({ error: '仅可启用本企业房产的线路' });
  if (line.status === 'active') return res.status(400).json({ error: '线路已启用' });
  await pool.query(
    "UPDATE room_net_lines SET status = 'active', start_date = ?, stop_date = NULL WHERE id = ? AND org_id = ?",
    [startDate, req.params.id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(after[0]);
}));

router.get('/netChanges', auth, h(async (req, res) => {
  const { room_id, month, building_id } = req.query;
  const personJoin = req.mode === 'property'
    ? 'LEFT JOIN tenants t ON t.id = r.owner_id'
    : `LEFT JOIN contracts c ON c.room_id = r.id AND c.status = 'active'
       LEFT JOIN tenants t ON t.id = c.tenant_id`;
  let sql = `SELECT ch.*, r.room_no, b.name AS building_name, t.name AS owner_name, t.phone AS owner_phone,
                l.line_name
               FROM net_changes ch JOIN rooms r ON r.id = ch.room_id
               JOIN buildings b ON b.id = r.building_id
               LEFT JOIN room_net_lines l ON l.id = ch.line_id ${personJoin}
              WHERE ch.org_id = ?`;
  const params = [req.orgId];
  if (room_id) { sql += ' AND ch.room_id = ?'; params.push(Number(room_id)); }
  if (month) { sql += ' AND ch.change_date LIKE ?'; params.push(month + '%'); }
  if (building_id) { sql += ' AND r.building_id = ?'; params.push(Number(building_id)); }
  if (req.level === 'company_admin') { sql += ' AND r.owner_id = ?'; params.push(req.companyId); }
  sql += ' ORDER BY ch.change_date DESC, ch.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(c => ({ ...c,
    delta: (Number(c.new_bandwidth) || 0) - (Number(c.old_bandwidth) || 0) })));
}));
router.post('/netChanges', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const roomId = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const lineId = v.int('line_id', { required: true, min: 1, max: 1e7 });
  const new_bandwidth = v.num('new_bandwidth', { required: true, min: 0, max: 1e6 });
  const change_date = v.date('change_date', { def: today() });
  const remark = v.str('remark', { max: 500 });
  v.ok();
  const [lines] = await pool.query(
    'SELECT * FROM room_net_lines WHERE id = ? AND org_id = ? AND room_id = ?', [lineId, req.orgId, roomId]);
  const line = lines[0];
  if (!line) return res.status(400).json({ error: '宽带线路不存在' });
  if (!(await ownRoomCheck(req, roomId))) return res.status(403).json({ error: '仅可变更本企业房产的带宽' });
  if (line.status !== 'active') return res.status(400).json({ error: '该线路已停用，不能变更带宽' });
  const oldBw = Number(line.bandwidth) || 0;
  const newBw = new_bandwidth;
  if (newBw === oldBw) return res.status(400).json({ error: '带宽未变化' });
  if (line.start_date && change_date < String(line.start_date)) {
    return res.status(400).json({ error: '变更日期不能早于线路开通日' });
  }
  const change_type = newBw > oldBw ? 'add' : 'reduce';
  const [r] = await pool.query(
    `INSERT INTO net_changes (org_id, room_id, line_id, change_date, change_type, old_bandwidth, new_bandwidth,
        remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.orgId, roomId, lineId, change_date, change_type, oldBw, newBw, remark || '', nowStr()]);
  await pool.query('UPDATE room_net_lines SET bandwidth = ? WHERE id = ? AND org_id = ?',
    [newBw, lineId, req.orgId]);
  const [rows] = await pool.query(
    `SELECT ch.*, l.line_name FROM net_changes ch LEFT JOIN room_net_lines l ON l.id = ch.line_id
      WHERE ch.id = ? AND ch.org_id = ?`, [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/netChanges/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM net_changes WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!rows.length) return res.status(400).json({ error: '记录不存在' });
  if (!(await ownRoomCheck(req, rows[0].room_id))) return res.status(403).json({ error: '仅可删除本企业房产的带宽变更记录' });
  await pool.query('DELETE FROM net_changes WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true,
    warn: '已删除变更记录。如该记录为最后一条，线路当前带宽未自动回滚，请到网络管理手动调整。' });
}));

/* ==================================================================
 * 宽带报装 / 加兆 / 减兆 上报申请（企业管理员提交；主管理员审批并执行）
 * ================================================================== */
router.get('/netRequests', auth, h(async (req, res) => {
  let sql = `SELECT q.*, r.room_no, b.name AS building_name, t.name AS company_name, l.line_name
               FROM net_requests q
               JOIN rooms r ON r.id = q.room_id
               JOIN buildings b ON b.id = r.building_id
               LEFT JOIN tenants t ON t.id = q.company_id
               LEFT JOIN room_net_lines l ON l.id = q.line_id
              WHERE q.org_id = ?`;
  const params = [req.orgId];
  if (req.level === 'company_admin') { sql += ' AND q.company_id = ?'; params.push(req.companyId); }
  sql += ' ORDER BY q.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));
router.post('/netRequests', auth, h(async (req, res) => {
  if (req.level !== 'admin' && req.level !== 'company_admin') {
    return res.status(403).json({ error: '仅主管理员或企业管理员可提交申请' });
  }
  const B = req.body || {};
  const v = V(B);
  const type = v.str('type', { required: true, enum: ['install', 'add', 'reduce'] });
  const roomId = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const line_id = v.int('line_id', { min: 1, max: 1e7 });
  const bandwidth = v.num('bandwidth', { min: 1, max: 1e6 });
  const delta = v.num('delta', { min: 0.01, max: 1e6 });
  const reason = v.str('reason', { max: 500 });
  v.ok();
  /* 企业管理员只能为本企业房产提交申请 */
  const roomSql = req.level === 'company_admin'
    ? 'SELECT id FROM rooms WHERE id = ? AND org_id = ? AND owner_id = ?'
    : 'SELECT id FROM rooms WHERE id = ? AND org_id = ?';
  const roomParams = req.level === 'company_admin' ? [roomId, req.orgId, req.companyId] : [roomId, req.orgId];
  const [[room]] = await pool.query(roomSql, roomParams);
  if (!room) return res.status(403).json({ error: '只能为本企业房产提交宽带申请' });
  let bandwidth2 = null, delta2 = null, lineId = null;
  if (type === 'install') {
    bandwidth2 = bandwidth;
    if (bandwidth2 === null) return res.status(400).json({ error: '请填写有效的报装带宽（兆）' });
  } else {
    lineId = line_id;
    if (!Number.isFinite(lineId)) return res.status(400).json({ error: '请选择宽带线路' });
    const [lines] = await pool.query(
      'SELECT * FROM room_net_lines WHERE id = ? AND org_id = ? AND room_id = ?', [lineId, req.orgId, roomId]);
    const line = lines[0];
    if (!line) return res.status(400).json({ error: '宽带线路不存在' });
    if (line.status !== 'active') return res.status(400).json({ error: '该线路已停用，不能申请变更' });
    delta2 = delta;
    if (delta2 === null) return res.status(400).json({ error: '请填写有效的增减兆数' });
    if (type === 'reduce' && (Number(line.bandwidth) || 0) - delta2 < 0) {
      return res.status(400).json({ error: '减兆后带宽不能为负' });
    }
  }
  const [r] = await pool.query(
    `INSERT INTO net_requests (org_id, company_id, room_id, type, bandwidth, delta, line_id, reason, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [req.orgId, req.level === 'company_admin' ? req.companyId : null, roomId, type,
     bandwidth2, delta2, lineId, reason || '', req.user.real_name || req.user.username, nowStr()]);
  const [rows] = await pool.query('SELECT * FROM net_requests WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
/* 审批：通过并执行（报装=建线路；加/减兆=写带宽变更）或驳回；仅主管理员 */
router.put('/netRequests/:id', auth, h(async (req, res) => {
  if (req.level !== 'admin') return res.status(403).json({ error: '仅主管理员可审批申请' });
  const B = req.body || {};
  const v = V(B);
  const action = v.str('action', { required: true, enum: ['approve', 'reject'] });
  const handle_note = v.str('handle_note', { max: 500 });
  v.ok();
  const [qs] = await pool.query('SELECT * FROM net_requests WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const q = qs[0];
  if (!q) return res.status(400).json({ error: '申请单不存在' });
  if (q.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
  const note = handle_note || '';
  if (action === 'reject') {
    await pool.query(
      `UPDATE net_requests SET status = 'rejected', handled_by = ?, handle_note = ?, handled_at = ? WHERE id = ?`,
      [req.user.real_name || req.user.username, note, nowStr(), req.params.id]);
    return res.json({ ok: true, status: 'rejected' });
  }
  const [[room]] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [q.room_id, req.orgId]);
  if (!room) return res.status(400).json({ error: '房间不存在' });
  if (q.type === 'install') {
    /* 报装：创建启用线路 */
    const [r] = await pool.query(
      `INSERT INTO room_net_lines (org_id, room_id, line_name, bandwidth, start_date, status, stop_date, remark, created_at)
       VALUES (?, ?, '默认线路', ?, ?, 'active', NULL, ?, ?)`,
      [req.orgId, q.room_id, q.bandwidth, today(), '报装审批通过：' + note, nowStr()]);
    await pool.query(
      `UPDATE net_requests SET status = 'done', handled_by = ?, handle_note = ?, handled_at = ? WHERE id = ?`,
      [req.user.real_name || req.user.username, note, nowStr(), req.params.id]);
    return res.json({ ok: true, status: 'done', line_id: r.insertId });
  }
  /* 加兆 / 减兆：写带宽变更并更新线路带宽 */
  const [lines] = await pool.query(
    'SELECT * FROM room_net_lines WHERE id = ? AND org_id = ? AND room_id = ?', [q.line_id, q.org_id, q.room_id]);
  const line = lines[0];
  if (!line) return res.status(400).json({ error: '宽带线路不存在' });
  if (line.status !== 'active') return res.status(400).json({ error: '该线路已停用，不能变更带宽' });
  const oldBw = Number(line.bandwidth) || 0;
  const newBw = q.type === 'add' ? oldBw + Number(q.delta) : oldBw - Number(q.delta);
  if (newBw < 0) return res.status(400).json({ error: '减兆后带宽不能为负' });
  if (newBw === oldBw) return res.status(400).json({ error: '带宽未变化' });
  const change_type = q.type === 'add' ? 'add' : 'reduce';
  await pool.query(
    `INSERT INTO net_changes (org_id, room_id, line_id, change_date, change_type, old_bandwidth, new_bandwidth, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.orgId, q.room_id, line.id, today(), change_type, oldBw, newBw, '审批通过：' + note, nowStr()]);
  await pool.query('UPDATE room_net_lines SET bandwidth = ? WHERE id = ? AND org_id = ?',
    [newBw, line.id, req.orgId]);
  await pool.query(
    `UPDATE net_requests SET status = 'done', handled_by = ?, handle_note = ?, handled_at = ? WHERE id = ?`,
    [req.user.real_name || req.user.username, note, nowStr(), req.params.id]);
  res.json({ ok: true, status: 'done', new_bandwidth: newBw });
}));

/* 网费预估（租房/物业）：房间月费 = 各启用线路费用之和，单价取主体设置 */
router.get('/netfee', auth, h(async (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const dim = daysInMonth(month);
  const { building_id } = req.query;
  let sql = `SELECT * FROM rooms WHERE org_id = ? AND ${FEATURES[req.mode].billable}`;
  const params = [req.orgId];
  if (building_id) { sql += ' AND building_id = ?'; params.push(Number(building_id)); }
  if (req.level === 'company_admin') { sql += ' AND owner_id = ?'; params.push(req.companyId); }
  const [rooms] = await pool.query(sql, params);
  const price = await netUnitPrice();
  const list = [];
  for (const r of rooms) {
    const calc = await calcNetFee(pool, r.id, month);
    const [lines] = await pool.query(
      `SELECT * FROM room_net_lines WHERE room_id = ? AND org_id = ? AND status = 'active' ORDER BY id`,
      [r.id, req.orgId]);
    const curBw = lines.reduce((s, l) => s + (Number(l.bandwidth) || 0), 0);
    const mStart = `${month}-01`;
    let monthStartBw = 0;
    for (const l of lines) {
      const bw = await getLineBandwidthAt(pool, l.id, mStart);
      monthStartBw += (bw === null ? 0 : bw);
    }
    const [b] = await pool.query('SELECT name FROM buildings WHERE id = ? AND org_id = ?', [r.building_id, req.orgId]);
    let person = { name: '', phone: '' };
    if (FEATURES[req.mode].owner) {
      const [o] = await pool.query('SELECT name, phone FROM tenants WHERE id = ? AND org_id = ?', [r.owner_id, req.orgId]);
      if (o.length) person = o[0];
    } else {
      const tid = await rentedTenant(pool, r.id, req.orgId);
      if (tid) {
        const [o] = await pool.query('SELECT name, phone FROM tenants WHERE id = ? AND org_id = ?', [tid, req.orgId]);
        if (o.length) person = o[0];
      }
    }
    const [[{ c }]] = await pool.query(
      'SELECT COUNT(*) AS c FROM net_changes WHERE room_id = ? AND org_id = ? AND change_date LIKE ?',
      [r.id, req.orgId, month + '%']);
    const [[{ tc }]] = await pool.query(
      'SELECT COUNT(*) AS c FROM net_changes WHERE room_id = ? AND org_id = ?', [r.id, req.orgId]);
    list.push({
      room_id: r.id, room_no: r.room_no, building_name: b.length ? b[0].name : '',
      owner_id: r.owner_id || null, owner_name: person.name, owner_phone: person.phone,
      bandwidth: curBw, price,
      month_start_bandwidth: monthStartBw,
      month_fee: calc.total, segments: calc.segments, lines: calc.lines, days_in_month: dim,
      changes_in_month: Number(c), total_changes: Number(tc),
      full_month_fee: round2(curBw * price)
    });
  }
  const sumFee = round2(list.reduce((s, x) => s + x.month_fee, 0));
  const sumBandwidth = list.reduce((s, x) => s + (x.bandwidth || 0), 0);
  const sumFull = round2(list.reduce((s, x) => s + x.full_month_fee, 0));
  res.json({ month, days_in_month: dim, list,
    summary: { sumFee, sumBandwidth, sumFull, count: list.length } });
}));

/* ==================================================================
 * 报修
 * ================================================================== */
router.get('/repairs', auth, h(async (req, res) => {
  const { status } = req.query;
  let person;
  if (req.mode === 'hotel') {
    person = `(SELECT t.name FROM orders o JOIN tenants t ON t.id = o.guest_id
       WHERE o.room_id = r.room_id AND o.status IN ('checked_in','booked') LIMIT 1)`;
  } else if (req.mode === 'property') {
    person = '(SELECT t.name FROM tenants t WHERE t.id = rm.owner_id)';
  } else {
    person = `(SELECT t.name FROM contracts c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.room_id = r.room_id AND c.status = 'active' LIMIT 1)`;
  }
  let sql = `SELECT r.*, rm.room_no, b.name AS building_name, ${person} AS tenant_name
    FROM repairs r JOIN rooms rm ON rm.id = r.room_id JOIN buildings b ON b.id = rm.building_id
    WHERE r.org_id = ?`;
  const params = [req.orgId];
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (req.level === 'company_admin') { sql += ' AND rm.owner_id = ?'; params.push(req.companyId); }
  sql += ' ORDER BY r.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));
router.post('/repairs', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { required: true, min: 1, max: 1e7 });
  const title = v.str('title', { required: true, max: 100 });
  const content = v.str('content', { max: 1000 });
  v.ok();
  if (req.level === 'company_admin') {
    const [[rm]] = await pool.query(
      'SELECT id FROM rooms WHERE id = ? AND org_id = ? AND owner_id = ?',
      [room_id, req.orgId, req.companyId]);
    if (!rm) return res.status(403).json({ error: '仅可报修本企业房产' });
  }
  const [r] = await pool.query(
    "INSERT INTO repairs (org_id, room_id, title, content, status, handler, handle_note, created_at) VALUES (?, ?, ?, ?, 'pending', '', '', ?)",
    [req.orgId, room_id, title, content || '', nowStr()]);
  const [rows] = await pool.query('SELECT * FROM repairs WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/repairs/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const status = v.str('status', { enum: ['pending', 'processing', 'done'], def: 'pending' });
  const handler = v.str('handler', { max: 50 });
  const handle_note = v.str('handle_note', { max: 1000 });
  v.ok();
  const [rp] = await pool.query('SELECT * FROM repairs WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!rp.length) return res.status(400).json({ error: '报修记录不存在' });
  if (!(await ownRoomCheck(req, rp[0].room_id))) return res.status(403).json({ error: '仅可处理本企业房产的报修' });
  const [r] = await pool.query(
    'UPDATE repairs SET status = ?, handler = ?, handle_note = ? WHERE id = ? AND org_id = ?',
    [status || 'pending', handler || '', handle_note || '', req.params.id, req.orgId]);
  const [rows] = await pool.query('SELECT * FROM repairs WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/repairs/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM repairs WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (rows.length && !(await ownRoomCheck(req, rows[0].room_id))) return res.status(403).json({ error: '仅可删除本企业房产的报修' });
  await pool.query('DELETE FROM repairs WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 投诉建议（物业）
 * ================================================================== */
router.get('/complaints', auth, h(async (req, res) => {
  const { status, type } = req.query;
  const cond = ['c.org_id = ?'];
  const params = [req.orgId];
  if (status) { cond.push('c.status = ?'); params.push(status); }
  if (type) { cond.push('c.type = ?'); params.push(type); }
  if (req.level === 'company_admin') { cond.push('r.owner_id = ?'); params.push(req.companyId); }
  const [rows] = await pool.query(
    `SELECT c.*, r.room_no, b.name AS building_name, t.name AS owner_name, t.phone AS owner_phone
       FROM complaints c LEFT JOIN rooms r ON r.id = c.room_id
       LEFT JOIN buildings b ON b.id = r.building_id LEFT JOIN tenants t ON t.id = c.owner_id
      WHERE ${cond.join(' AND ')} ORDER BY c.id DESC`, params);
  res.json(rows);
}));
router.post('/complaints', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const room_id = v.int('room_id', { min: 1, max: 1e7 });
  const owner_id = v.int('owner_id', { min: 1, max: 1e7 });
  const type = v.str('type', { enum: ['投诉', '建议', '咨询', '其他'], def: '投诉' });
  const title = v.str('title', { required: true, max: 100 });
  const content = v.str('content', { max: 1000 });
  v.ok();
  if (room_id && !(await ownRoomCheck(req, room_id))) return res.status(403).json({ error: '仅可投诉本企业房产' });
  const [r] = await pool.query(
    `INSERT INTO complaints (org_id, room_id, owner_id, type, title, content, status, handler, handle_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', '', '', ?)`,
    [req.orgId, room_id || 0, owner_id || null,
     type || '投诉', title, content || '', nowStr()]);
  const [rows] = await pool.query('SELECT * FROM complaints WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/complaints/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const status = v.str('status', { enum: ['pending', 'processing', 'done'], def: 'pending' });
  const handler = v.str('handler', { max: 50 });
  const handle_note = v.str('handle_note', { max: 1000 });
  v.ok();
  const [cp] = await pool.query('SELECT * FROM complaints WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!cp.length) return res.status(400).json({ error: '记录不存在' });
  if (cp[0].room_id && !(await ownRoomCheck(req, cp[0].room_id))) return res.status(403).json({ error: '仅可处理本企业房产的投诉' });
  const [r] = await pool.query(
    'UPDATE complaints SET status = ?, handler = ?, handle_note = ? WHERE id = ? AND org_id = ?',
    [status || 'pending', handler || '', handle_note || '', req.params.id, req.orgId]);
  const [rows] = await pool.query('SELECT * FROM complaints WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/complaints/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM complaints WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (rows.length && rows[0].room_id && !(await ownRoomCheck(req, rows[0].room_id))) return res.status(403).json({ error: '仅可删除本企业房产的投诉' });
  await pool.query('DELETE FROM complaints WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 角色（主管理员管理本主体员工角色；超管管理内置角色）
 * ================================================================== */
router.get('/roles', authMode, adminLevel, h(async (req, res) => {
  if (req.level === 'super') {
    const [rows] = await shared.query('SELECT * FROM roles WHERE org_id IS NULL ORDER BY id');
    return res.json(rows.map(r => ({ ...r, is_system: Number(r.is_system), user_count: 0, pages: [] })));
  }
  /* 主管理员：内置 staff 角色 + 本主体自建角色 */
  const [rows] = await shared.query(
    `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = r.code AND u.org_id = r.org_id) AS user_count
       FROM roles r WHERE r.org_id = ? OR (r.org_id IS NULL AND r.level = 'staff')
      ORDER BY r.is_system DESC, r.id`, [req.orgId]);
  const [perms] = await shared.query(
    `SELECT rp.page, r.id AS role_id FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      WHERE r.org_id = ?`, [req.orgId]);
  const byRole = {};
  for (const p of perms) (byRole[p.role_id] = byRole[p.role_id] || []).push(p.page);
  res.json(rows.map(r => {
    const items = byRole[r.id] || [];
    const pages = [], ops = [];
    for (const it of items) {
      const v = String(it);
      if (v.startsWith('op:')) ops.push(v.slice(3));
      else pages.push(v);
    }
    return {
      ...r, is_system: Number(r.is_system), user_count: Number(r.user_count),
      pages: [...new Set(pages)], ops: [...new Set(ops)]
    };
  }));
}));
router.post('/roles', authMode, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const code = v.str('code', { required: true, max: 30, pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,29}$/ });
  const name = v.str('name', { required: true, max: 50 });
  const description = v.str('description', { max: 200 });
  v.ok();
  const pages = v.arr('pages', { max: 30, itemMax: 30 });
  const ops = v.arr('ops', { max: 60, itemMax: 40 });
  v.ok();
  if (req.level === 'super') {
    const level = ['super', 'admin', 'staff'].includes(B.level) ? B.level : 'staff';
    const [[dup]] = await shared.query('SELECT COUNT(*) AS c FROM roles WHERE org_id IS NULL AND code = ?', [code]);
    if (Number(dup.c) > 0) return res.status(400).json({ error: '角色编码已存在' });
    const [r] = await shared.query(
      'INSERT INTO roles (org_id, code, name, description, level) VALUES (NULL, ?, ?, ?, ?)',
      [code, name, description || '', level]);
    const [rows] = await shared.query('SELECT * FROM roles WHERE id = ?', [r.insertId]);
    return res.json({ ...rows[0], pages: [] });
  }
  /* 主管理员只能在本主体建 staff 角色 */
  const orgId = req.orgId;
  const [[dup]] = await shared.query('SELECT COUNT(*) AS c FROM roles WHERE org_id = ? AND code = ?', [orgId, code]);
  if (Number(dup.c) > 0) return res.status(400).json({ error: '角色编码已存在' });
  const [r] = await shared.query(
    'INSERT INTO roles (org_id, code, name, description, level) VALUES (?, ?, ?, ?, "staff")',
    [orgId, code, name, description || '']);
  await setRolePerms(r.insertId, pages, ops);
  const [rows] = await shared.query('SELECT * FROM roles WHERE id = ?', [r.insertId]);
  res.json({ ...rows[0],
    pages: [...new Set(pages)],
    ops: [...new Set(ops)] });
}));
router.put('/roles/:id', authMode, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const name = v.str('name', { required: true, max: 50 });
  const code = v.str('code', { max: 30, pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,29}$/ });
  const description = v.str('description', { max: 200 });
  v.ok();
  const pages = v.arr('pages', { max: 30, itemMax: 30 });
  const ops = v.arr('ops', { max: 60, itemMax: 40 });
  v.ok();
  const [rs] = await shared.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  if (!rs.length) return res.status(400).json({ error: '角色不存在' });
  const role = rs[0];
  /* 主管理员只能改本主体自建角色 */
  if (req.level !== 'super' && role.org_id !== req.orgId) {
    return res.status(403).json({ error: '只能管理本系统角色' });
  }
  if (!name) return res.status(400).json({ error: '角色名称不能为空' });
  if (Number(role.is_system) || (req.level !== 'super' && role.org_id === null)) {
    await shared.query('UPDATE roles SET name = ?, description = ? WHERE id = ?',
      [name, description || '', req.params.id]);
  } else {
    if (!code) return res.status(400).json({ error: '角色编码不能为空' });
    const [[dup]] = await shared.query(
      'SELECT COUNT(*) AS c FROM roles WHERE code = ? AND org_id <=> ? AND id <> ?',
      [code, role.org_id, req.params.id]);
    if (Number(dup.c) > 0) return res.status(400).json({ error: '角色编码已存在' });
    await shared.query('UPDATE roles SET code = ?, name = ?, description = ? WHERE id = ?',
      [code, name, description || '', req.params.id]);
    /* 自建角色可配置页面与操作权限（内置/全局角色不设） */
    if (role.org_id !== null) await setRolePerms(req.params.id, pages, ops);
  }
  const [rows] = await shared.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  const rp = role.org_id !== null && !Number(role.is_system)
    ? await rolePerms(req.params.id) : { pages: [], ops: [] };
  res.json({ ...rows[0], pages: rp.pages, ops: rp.ops });
}));
router.delete('/roles/:id', authMode, h(async (req, res) => {
  const [rs] = await shared.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  if (!rs.length) return res.status(400).json({ error: '角色不存在' });
  const role = rs[0];
  if (req.level !== 'super' && role.org_id !== req.orgId) {
    return res.status(403).json({ error: '只能管理本系统角色' });
  }
  if (Number(role.is_system) || role.org_id === null) {
    return res.status(400).json({ error: '系统内置角色不可删除' });
  }
  const [[used]] = await shared.query(
    'SELECT COUNT(*) AS c FROM users WHERE role = ? AND org_id = ?', [role.code, role.org_id]);
  if (Number(used.c) > 0) return res.status(400).json({ error: '该角色已分配给员工，无法删除' });
  await shared.query('DELETE FROM role_permissions WHERE role_id = ?', [req.params.id]);
  await shared.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ==================================================================
 * 员工管理（主管理员仅管理本主体员工；超管通过 /orgs 管理主体）
 * ================================================================== */
router.get('/users', authMode, orgAdminOnly, h(async (req, res) => {
  const [rows] = await shared.query(
    `SELECT u.id, u.username, u.real_name, u.role, u.mode, u.org_id,
            COALESCE(rc.name, rb.name) AS role_name, COALESCE(rc.level, rb.level) AS level, u.created_at
       FROM users u
       LEFT JOIN roles rc ON rc.code = u.role AND rc.org_id = u.org_id
       LEFT JOIN roles rb ON rb.code = u.role AND rb.org_id IS NULL
      WHERE u.org_id = ? ORDER BY u.id`, [req.orgId]);
  const [rolePerms] = await shared.query(
    `SELECT r.code, rp.page FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      WHERE r.org_id = ?`, [req.orgId]);
  const byRole = {};
  for (const p of rolePerms) (byRole[p.code] = byRole[p.code] || []).push(p.page);
  res.json(rows.map(u => {
    const items = byRole[u.role] || [];
    const pages = [], ops = [];
    for (const it of items) {
      const v = String(it);
      if (v.startsWith('op:')) ops.push(v.slice(3));
      else pages.push(v);
    }
    return { ...u, pages: [], role_pages: [...new Set(pages)], role_ops: [...new Set(ops)] };
  }));
}));
router.post('/users', authMode, orgAdminOnly, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const username = v.str('username', { required: true, max: 50, pattern: /^[A-Za-z0-9_@.\-]+$/ });
  const password = v.str('password', { required: true, max: 100, clean: false });
  const real_name = v.str('real_name', { max: 50 });
  const role = v.str('role', { required: true, max: 30, pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/ });
  v.ok();
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const [meta] = await shared.query(
    'SELECT * FROM roles WHERE code = ? AND (org_id = ? OR (org_id IS NULL AND level = "staff")) LIMIT 1',
    [role, req.orgId]);
  if (!meta.length) return res.status(400).json({ error: '角色不存在' });
  /* 账号名同系统内唯一（跨系统/跨主体可重名，按系统独立运营） */
  const [[dup]] = await shared.query(
    'SELECT COUNT(*) AS c FROM users WHERE mode = ? AND username = ?', [req.mode, username]);
  if (Number(dup.c) > 0) return res.status(400).json({ error: '该用户名在本系统已存在' });
  const [ins] = await shared.query(
    'INSERT INTO users (username, password, real_name, role, mode, org_id) VALUES (?, ?, ?, ?, ?, ?)',
    [username, hashPassword(password), real_name || '', role, req.mode, req.orgId]);
  const [rows] = await shared.query(
    `SELECT u.id, u.username, u.real_name, u.role, u.mode, u.org_id,
            COALESCE(rc.name, rb.name) AS role_name
       FROM users u
       LEFT JOIN roles rc ON rc.code = u.role AND rc.org_id = u.org_id
       LEFT JOIN roles rb ON rb.code = u.role AND rb.org_id IS NULL
      WHERE u.id = ?`, [ins.insertId]);
  res.json(rows[0]);
}));
router.put('/users/:id', authMode, orgAdminOnly, h(async (req, res) => {
  const B = req.body || {};
  const v = V(B);
  const username = v.str('username', { max: 50, pattern: /^[A-Za-z0-9_@.\-]+$/ });
  const password = v.str('password', { max: 100, clean: false });
  const real_name = v.str('real_name', { max: 50 });
  const role = v.str('role', { max: 30, pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/ });
  v.ok();
  const [us] = await shared.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!us.length) return res.status(400).json({ error: '用户不存在' });
  const target = us[0];
  if (target.org_id !== req.orgId || target.role === 'admin') {
    return res.status(403).json({ error: '只能管理本系统员工' });
  }
  /* 未传 role 时保持原角色，避免误改 */
  const newRole = role !== null ? role : target.role;
  const [meta] = await shared.query(
    'SELECT * FROM roles WHERE code = ? AND (org_id = ? OR (org_id IS NULL AND level = "staff")) LIMIT 1',
    [newRole, req.orgId]);
  if (!meta.length) return res.status(400).json({ error: '角色不存在' });
  await shared.query('UPDATE users SET real_name = ?, role = ? WHERE id = ?',
    [real_name !== null ? real_name : target.real_name, newRole, req.params.id]);
  if (password) {
    await shared.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(password), req.params.id]);
  }
  const [rows] = await shared.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
}));
router.delete('/users/:id', authMode, orgAdminOnly, h(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: '不能删除当前登录用户' });
  const [us] = await shared.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!us.length) return res.status(400).json({ error: '用户不存在' });
  const target = us[0];
  if (target.org_id !== req.orgId || target.role === 'admin') {
    return res.status(403).json({ error: '只能管理本系统员工' });
  }
  await shared.query('DELETE FROM user_permissions WHERE user_id = ?', [req.params.id]);
  await shared.query('DELETE FROM sessions WHERE user_id = ?', [req.params.id]);
  await shared.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.use('/api', router);
app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

const PORT = Number(process.env.PORT || 16088);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`房屋管理系统已启动：http://localhost:${PORT}`);
});
