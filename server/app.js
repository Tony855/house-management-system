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
const pool = require('./db');
const { shared, getPool, withMode, currentOrgId, currentMode, MODES } = require('./db');
const {
  hashPassword, verifyPassword, today, nowStr, addDays, addMonths, daysBetween,
  daysInMonth, monthStart, monthEnd
} = require('./util');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- 辅助 ---------- */
const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.message });
});
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

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
      segments: calc.segments });
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
    `SELECT u.id, u.username, u.real_name, u.role, u.mode AS user_mode, u.org_id,
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
  req.level = u.level || 'staff';
  req.mode = u.session_mode || u.user_mode || 'rental';
  req.orgId = u.session_org || u.org_id || null;
  req.orgName = u.org_name || null;
  const [pages] = await shared.query('SELECT page FROM user_permissions WHERE user_id = ?', [u.id]);
  req.pages = pages.map(p => p.page);
  next();
}
const wrap = (req, res, next) => withMode(req.mode, req.orgId, next);
const authMode = (req, res, next) => authenticate(req, res, () => wrap(req, res, next));

/* 集中式页面权限（员工按授予页面；主管理员/超管全放行） */
const ROUTE_PAGES = [
  [/^\/stats/, ['dashboard']],
  [/^\/buildings/, ['rooms', 'roommap', 'buildings', 'properties']],
  [/^\/rooms/, ['rooms', 'roommap', 'properties']],
  [/^\/tenants/, ['tenants', 'owners']],
  [/^\/contracts/, ['contracts']],
  [/^\/orders/, ['orders']],
  [/^\/bills/, ['bills']],
  [/^\/meters/, ['meters']],
  [/^\/netChanges/, ['network']],
  [/^\/netfee/, ['network']],
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
const authPerm = (req, res, next) => authMode(req, res, () => {
  /* 超级管理员只负责开通主体与系统监控，不参与任何业务数据读写 */
  if (req.level === 'super') return res.status(403).json({ error: '超级管理员不参与业务操作' });
  if (!checkFeature(req)) return res.status(404).json({ error: '当前系统不提供该功能' });
  if (!checkPagePerm(req)) return res.status(403).json({ error: '无权访问该功能' });
  next();
});
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

/* 员工实际可访问页面 = 角色权限 ∪ 个人权限（按主体隔离；动态生效，改角色权限即时反映） */
async function userPages(userId) {
  const [[u]] = await shared.query('SELECT role, org_id FROM users WHERE id = ?', [userId]);
  const [personal] = await shared.query('SELECT page FROM user_permissions WHERE user_id = ?', [userId]);
  let rolePages = [];
  if (u && u.role) {
    const [rps] = await shared.query(
      `SELECT rp.page FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = ? AND r.org_id = ?`, [u.role, u.org_id]);
    rolePages = rps.map(p => p.page);
  }
  return [...new Set([...personal.map(p => p.page), ...rolePages])];
}
/* 覆盖写角色权限（主管理员自建角色；内置/全局角色不设权限） */
async function setRolePages(roleId, pages) {
  await shared.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  if (Array.isArray(pages)) {
    for (const p of [...new Set(pages)]) {
      await shared.query('INSERT IGNORE INTO role_permissions (role_id, page) VALUES (?, ?)', [roleId, p]);
    }
  }
}

/* ==================================================================
 * 登录 / 会话
 * ================================================================== */
router.post('/login', h(async (req, res) => {
  const B = req.body || {};
  const { username, password } = B;
  /* 入口强绑定：账号必须从所属系统窗口登录（超管=super 窗口；业务账号=对应系统窗口）。
   * 跨系统信息一律不外泄——查不到/不匹配统一返回「用户名或密码错误」。 */
  const modeQ = B.mode === 'super' ? 'AND u.mode IS NULL'
              : B.mode            ? 'AND u.mode = ?'
              : 'AND 1 = 0';
  const params = [username || '', ...(B.mode && B.mode !== 'super' ? [B.mode] : [])];
  const [rows] = await shared.query(
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
  const token = crypto.randomBytes(32).toString('hex');
  await shared.query('INSERT INTO sessions (token, user_id, mode, org_id) VALUES (?, ?, ?, ?)',
    [token, u.id, mode, u.org_id || null]);
  const pages = await userPages(u.id);
  res.json({
    id: u.id, username: u.username, name: u.real_name,
    role: u.role, role_name: u.role_name, level: u.level || 'staff',
    mode, org_id: u.org_id || null, org_name: u.org_name || null,
    pages, token
  });
}));

router.get('/me', authMode, h(async (req, res) => {
  const pages = await userPages(req.user.id);
  res.json({
    id: req.user.id, username: req.user.username, name: req.user.real_name,
    role: req.user.role, role_name: req.user.role_name,
    level: req.level, mode: req.mode, org_id: req.orgId, org_name: req.orgName,
    pages
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
  const name = String(B.name || '').trim();
  const mode = B.mode;
  const username = String(B.username || '').trim();
  const password = String(B.password || '');
  if (!name) return res.status(400).json({ error: '经营主体名称不能为空' });
  if (!MODES.includes(mode)) return res.status(400).json({ error: '请选择所属系统' });
  if (!username || password.length < 6) return res.status(400).json({ error: '管理员用户名不能为空，密码至少 6 位' });
  const [[dup]] = await shared.query('SELECT COUNT(*) AS c FROM users WHERE username = ?', [username]);
  if (Number(dup.c) > 0) return res.status(400).json({ error: '用户名已存在' });

  const conn = await shared.getConnection();
  try {
    await conn.beginTransaction();
    const [orgR] = await conn.query('INSERT INTO orgs (name, mode) VALUES (?, ?)', [name, mode]);
    const orgId = orgR.insertId;
    const [uR] = await conn.query(
      'INSERT INTO users (username, password, real_name, role, mode, org_id) VALUES (?, ?, ?, ?, ?, ?)',
      [username, hashPassword(password), B.real_name || name + '管理员', 'admin', mode, orgId]);
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
  const [os] = await shared.query('SELECT * FROM orgs WHERE id = ?', [req.params.id]);
  if (!os.length) return res.status(400).json({ error: '经营主体不存在' });
  const o = os[0];
  if (B.name !== undefined) {
    const name = String(B.name).trim();
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    await shared.query('UPDATE orgs SET name = ? WHERE id = ?', [name, o.id]);
  }
  if (B.real_name !== undefined) {
    await shared.query('UPDATE users SET real_name = ? WHERE id = ?', [B.real_name || '', o.admin_user_id]);
  }
  if (B.password) {
    if (String(B.password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    await shared.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(B.password), o.admin_user_id]);
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
  if (!req.orgId) return res.json({ mode: req.mode, ...DEF_SETTINGS, prices: false });
  const s = await getOrgSettings(req.orgId);
  const base = s || { org_id: req.orgId, ...DEF_SETTINGS };
  res.json({
    currency: base.currency, rate: Number(base.rate),
    net_price_per_mb: Number(base.net_price_per_mb),
    water_price: Number(base.water_price), elec_price: Number(base.elec_price),
    prices: FEATURES[req.mode].settingsPrices
  });
}));

router.put('/settings', authMode, orgAdminOnly, h(async (req, res) => {
  const B = req.body || {};
  const s = (await getOrgSettings(req.orgId)) || { ...DEF_SETTINGS };
  const currency = (B.currency === 'CNY' || B.currency === 'USD') ? B.currency : s.currency;
  const rate = (Number(B.rate) > 0) ? Number(B.rate) : Number(s.rate);
  let net = Number(s.net_price_per_mb), water = Number(s.water_price), elec = Number(s.elec_price);
  if (FEATURES[req.mode].settingsPrices) {
    const pick = (v, cur) => (v !== undefined && Number(v) >= 0) ? Number(v) : cur;
    net = pick(B.net_price_per_mb, net);
    water = pick(B.water_price, water);
    elec = pick(B.elec_price, elec);
  }
  await shared.query(
    `INSERT INTO settings (org_id, currency, rate, net_price_per_mb, water_price, elec_price)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE currency = VALUES(currency), rate = VALUES(rate),
       net_price_per_mb = VALUES(net_price_per_mb), water_price = VALUES(water_price),
       elec_price = VALUES(elec_price)`,
    [req.orgId, currency, rate, net, water, elec]);
  res.json({ currency, rate: Number(rate), net_price_per_mb: net, water_price: water, elec_price: elec,
    prices: FEATURES[req.mode].settingsPrices });
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
  const empty = () => ({
    total_rooms: 0, vacant: 0, rented: 0, booked: 0, cleaning: 0, maintenance: 0, occupancy: 0,
    month_receivable: 0, month_received: 0, arrears: 0, pending_repairs: 0,
    today_checkin: 0, today_checkout: 0, today_revenue: 0, staying_deposit: 0,
    expiring: [], recent_bills: [], recent_orders: [], dirty_rooms: [],
    owner_count: 0, property_receivable: 0, property_received: 0, property_arrears: 0, pay_rate: 0,
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
       FROM rooms WHERE org_id = ?`, [oid]);
  Object.assign(R, {
    total_rooms: Number(roomStat.total), vacant: Number(roomStat.vacant), rented: Number(roomStat.rented),
    booked: Number(roomStat.booked), cleaning: Number(roomStat.cleaning), maintenance: Number(roomStat.maintenance)
  });
  R.occupancy = R.total_rooms ? Math.round(R.rented / R.total_rooms * 100) : 0;

  const [monthBills] = await pool.query(
    'SELECT amount, paid_amount FROM bills WHERE org_id = ? AND (due_date LIKE ? OR period_start LIKE ?)',
    [oid, ym + '%', ym + '%']);
  R.month_receivable = round2(monthBills.reduce((s, b) => s + Number(b.amount), 0));
  R.month_received = round2(monthBills.reduce((s, b) => s + Number(b.paid_amount || 0), 0));
  const [allBills] = await pool.query('SELECT amount, paid_amount FROM bills WHERE org_id = ?', [oid]);
  R.arrears = round2(allBills.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0));
  const [[rp]] = await pool.query("SELECT COUNT(*) AS c FROM repairs WHERE org_id = ? AND status <> 'done'", [oid]);
  R.pending_repairs = Number(rp.c);
  const [[mr]] = await pool.query('SELECT COUNT(*) AS c FROM repairs WHERE org_id = ? AND created_at LIKE ?', [oid, ym + '%']);
  R.month_repairs = Number(mr.c);

  const [recentBills] = await pool.query(
    `SELECT b.*, r.room_no, t.name AS tenant_name
       FROM bills b LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN tenants t ON t.id = b.tenant_id
      WHERE b.org_id = ? ORDER BY b.id DESC LIMIT 6`, [oid]);
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

  /* 物业：业主 */
  if (f.owner) {
    const [ownedRooms] = await pool.query(
      `SELECT r.*, b.name AS building_name, t.name AS owner_name, t.phone AS owner_phone
         FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id
         LEFT JOIN tenants t ON t.id = r.owner_id
        WHERE r.org_id = ? AND r.owner_id IS NOT NULL`, [oid]);
    R.owner_count = new Set(ownedRooms.map(r => r.owner_id)).size;
    const [[bwRow]] = await pool.query(
      `SELECT COALESCE(SUM(l.bandwidth),0) AS s FROM room_net_lines l JOIN rooms r ON r.id = l.room_id
        WHERE l.org_id = ? AND l.status = 'active' AND r.owner_id IS NOT NULL`, [oid]);
    R.total_bandwidth = Number(bwRow.s);
    for (const r of ownedRooms) R.net_estimate_month += (await calcNetFee(pool, r.id, ym)).total;
    R.net_estimate_month = round2(R.net_estimate_month);
    R.arrears_rooms = computeArrearsRooms(ownedRooms, allBills);
  }

  /* 水电抄表（租房/物业） */
  if (f.meter) {
    const [monthMeters] = await pool.query('SELECT * FROM meters WHERE org_id = ? AND month = ?', [oid, ym]);
    R.meter_water_fee = monthMeters.reduce((s, m) => s + Number(m.water_fee || 0), 0);
    R.meter_elec_fee = monthMeters.reduce((s, m) => s + Number(m.elec_fee || 0), 0);
    R.meter_water_usage = monthMeters.reduce((s, m) => s + Number(m.water_usage || 0), 0);
    R.meter_elec_usage = monthMeters.reduce((s, m) => s + Number(m.elec_usage || 0), 0);
  }

  /* 网费（租房/物业） */
  if (f.network) {
    const [netBills] = await pool.query("SELECT * FROM bills WHERE org_id = ? AND source = 'network'", [oid]);
    const netMonth = netBills.filter(b => (b.due_date || '').startsWith(ym) || (b.period_start || '').startsWith(ym));
    R.net_receivable = round2(netMonth.reduce((s, b) => s + Number(b.amount), 0));
    R.net_received = round2(netMonth.reduce((s, b) => s + Number(b.paid_amount || 0), 0));
    R.net_arrears = round2(netBills.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0));
    const [[ncm]] = await pool.query(
      'SELECT COUNT(*) AS c FROM net_changes WHERE org_id = ? AND change_date LIKE ?', [oid, ym + '%']);
    R.net_change_month = Number(ncm.c);
    if (!f.owner) {
      /* 租房：网费房间为已出租房间 */
      const [rentedRooms] = await pool.query(
        `SELECT r.*, b.name AS building_name FROM rooms r LEFT JOIN buildings b ON b.id = r.building_id
          WHERE r.org_id = ? AND r.status = 'rented'`, [oid]);
      const [[bwRow]] = await pool.query(
        `SELECT COALESCE(SUM(l.bandwidth),0) AS s FROM room_net_lines l JOIN rooms r ON r.id = l.room_id
          WHERE l.org_id = ? AND l.status = 'active' AND r.status = 'rented'`, [oid]);
      R.total_bandwidth = Number(bwRow.s);
      for (const r of rentedRooms) R.net_estimate_month += (await calcNetFee(pool, r.id, ym)).total;
      R.net_estimate_month = round2(R.net_estimate_month);
      R.arrears_rooms = computeArrearsRooms(rentedRooms, allBills);
    }
    /* 物业账单口径（物业费+水电） */
    if (f.owner) {
      const [propertyBills] = await pool.query("SELECT * FROM bills WHERE org_id = ? AND source = 'property'", [oid]);
      const pm = propertyBills.filter(b => (b.due_date || '').startsWith(ym) || (b.period_start || '').startsWith(ym));
      R.property_receivable = round2(pm.reduce((s, b) => s + Number(b.amount), 0));
      R.property_received = round2(pm.reduce((s, b) => s + Number(b.paid_amount || 0), 0));
      R.property_arrears = round2(propertyBills.reduce((s, b) => s + (Number(b.amount) - Number(b.paid_amount || 0)), 0));
      R.pay_rate = R.property_receivable ? Math.round(R.property_received / R.property_receivable * 100) : 0;
    }
  }

  /* 投诉（物业） */
  if (f.complaint) {
    const [[pc]] = await pool.query("SELECT COUNT(*) AS c FROM complaints WHERE org_id = ? AND status <> 'done'", [oid]);
    R.pending_complaints = Number(pc.c);
    const [recentComplaints] = await pool.query(
      `SELECT c.*, r.room_no, b.name AS building_name, t.name AS owner_name
         FROM complaints c LEFT JOIN rooms r ON r.id = c.room_id
         LEFT JOIN buildings b ON b.id = r.building_id LEFT JOIN tenants t ON t.id = c.owner_id
        WHERE c.org_id = ? ORDER BY c.id DESC LIMIT 6`, [oid]);
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
  if (!B.name) return res.status(400).json({ error: '楼栋名称不能为空' });
  const [r] = await pool.query(
    'INSERT INTO buildings (org_id, name, address, remark) VALUES (?, ?, ?, ?)',
    [req.orgId, B.name, B.address || '', B.remark || '']);
  const [rows] = await pool.query('SELECT * FROM buildings WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json({ ...rows[0], room_count: 0 });
}));
router.put('/buildings/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [r] = await pool.query(
    'UPDATE buildings SET name = ?, address = ?, remark = ? WHERE id = ? AND org_id = ?',
    [B.name, B.address || '', B.remark || '', req.params.id, req.orgId]);
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
  const [rows] = await pool.query(
    roomSelectSql(req.mode) + ' WHERE ' + cond.join(' AND ') + ' ORDER BY r.id', params);
  res.json(rows);
}));
function roomPayload(B, mode) {
  const d = { org_id: currentOrgId(), remark: B.remark || '', room_no: B.room_no,
    room_type: B.room_type || '', status: B.status || 'vacant' };
  for (const k of ROOM_FIELDS[mode]) {
    if (k === 'room_no' || k === 'room_type' || k === 'status' || k === 'remark') continue;
    d[k] = NUM_ROOM_FIELDS.includes(k) ? num(B[k]) : B[k];
  }
  return d;
}
router.post('/rooms', auth, h(async (req, res) => {
  const B = req.body || {};
  if (!B.building_id || !B.room_no) return res.status(400).json({ error: '楼栋与房间号不能为空' });
  const mode = req.mode;
  const d = roomPayload(B, mode);
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
  const d = roomPayload(B, mode);
  delete d.org_id;
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
 * 租客 / 房客 / 业主
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
  let sql = `SELECT t.*, ${roomExpr} FROM tenants t WHERE t.org_id = ?`;
  const params = [req.orgId];
  if (keyword) { sql += ' AND (t.name LIKE ? OR t.phone LIKE ?)'; params.push('%' + keyword + '%', '%' + keyword + '%'); }
  sql += ' ORDER BY t.id';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));
router.post('/tenants', auth, h(async (req, res) => {
  const B = req.body || {};
  if (!B.name || !B.phone) return res.status(400).json({ error: '姓名与联系电话不能为空' });
  const [r] = await pool.query(
    'INSERT INTO tenants (org_id, name, gender, phone, id_card, remark) VALUES (?, ?, ?, ?, ?, ?)',
    [req.orgId, B.name, B.gender === '女' ? '女' : '男', B.phone, B.id_card || '', B.remark || '']);
  const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json({ ...rows[0], rooms: '' });
}));
router.put('/tenants/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [r] = await pool.query(
    'UPDATE tenants SET name = ?, gender = ?, phone = ?, id_card = ?, remark = ? WHERE id = ? AND org_id = ?',
    [B.name, B.gender === '女' ? '女' : '男', B.phone, B.id_card || '', B.remark || '', req.params.id, req.orgId]);
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
    if (Number(c) > 0) return res.status(400).json({ error: '该业主名下仍有房产，请先解除绑定' });
  }
  await pool.query('DELETE FROM tenants WHERE id = ? AND org_id = ?', [id, oid]);
  res.json({ ok: true });
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
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [Number(B.room_id), req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  if (room.status === 'rented') return res.status(400).json({ error: '该房间已出租' });
  const contract_no = 'HT' + Date.now().toString().slice(-8);
  const [r] = await pool.query(
    `INSERT INTO contracts (org_id, contract_no, room_id, tenant_id, start_date, end_date, rent, deposit,
        pay_cycle, sign_date, status, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [req.orgId, contract_no, Number(B.room_id), Number(B.tenant_id), B.start_date, B.end_date,
     Number(B.rent) || 0, Number(B.deposit) || 0, Number(B.pay_cycle) || 1, B.sign_date || today(), B.remark || '']);
  await pool.query("UPDATE rooms SET status = 'rented' WHERE id = ? AND org_id = ?", [room.id, req.orgId]);
  const [rows] = await pool.query('SELECT * FROM contracts WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json({ ...rows[0], rent: Number(rows[0].rent), deposit: Number(rows[0].deposit) });
}));
router.put('/contracts/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [r] = await pool.query(
    `UPDATE contracts SET room_id = ?, tenant_id = ?, start_date = ?, end_date = ?, rent = ?,
            deposit = ?, pay_cycle = ?, sign_date = ?, remark = ? WHERE id = ? AND org_id = ?`,
    [Number(B.room_id), Number(B.tenant_id), B.start_date, B.end_date, Number(B.rent) || 0,
     Number(B.deposit) || 0, Number(B.pay_cycle) || 1, B.sign_date || today(), B.remark || '',
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
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [Number(B.room_id), req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  const days = daysBetween(B.check_in_date, B.check_out_date);
  const day_price = Number(B.day_price) || 0;
  const total = days * day_price;
  const [r] = await pool.query(
    `INSERT INTO orders (org_id, order_no, room_id, guest_id, check_in_date, check_out_date, days, day_price,
        total, deposit, status, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
    [req.orgId, 'DD' + Date.now().toString().slice(-8), Number(B.room_id), Number(B.guest_id),
     B.check_in_date, B.check_out_date, days, day_price, total, Number(B.deposit) || 0, B.remark || '', nowStr()]);
  if (room.status === 'vacant') {
    await pool.query("UPDATE rooms SET status = 'booked' WHERE id = ? AND org_id = ?", [room.id, req.orgId]);
  }
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(normOrder(rows[0]));
}));
router.put('/orders/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [os] = await pool.query('SELECT * FROM orders WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!os.length) return res.status(400).json({ error: '订单不存在' });
  const days = daysBetween(B.check_in_date, B.check_out_date);
  const day_price = Number(B.day_price) || 0;
  await pool.query(
    `UPDATE orders SET room_id = ?, guest_id = ?, check_in_date = ?, check_out_date = ?, days = ?,
            day_price = ?, total = ?, deposit = ?, remark = ? WHERE id = ? AND org_id = ?`,
    [Number(B.room_id), Number(B.guest_id), B.check_in_date, B.check_out_date, days, day_price,
     days * day_price, Number(B.deposit) || 0, B.remark || '', req.params.id, req.orgId]);
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
const normBill = b => ({ ...b, amount: Number(b.amount), paid_amount: Number(b.paid_amount) });
router.get('/bills', auth, h(async (req, res) => {
  const { status, source } = req.query;
  const cond = ['b.org_id = ?'];
  const params = [req.orgId];
  if (status) { cond.push('b.status = ?'); params.push(status); }
  if (source) { cond.push('b.source = ?'); params.push(source); }
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
  const kind = (req.body && req.body.kind) || 'all';
  const roomId = (req.body && req.body.room_id) ? Number(req.body.room_id) : null;
  const oid = req.orgId;
  const t = today(), ym = t.slice(0, 7);
  const start = monthStart(t), end = addDays(addMonths(start, 1), -1);
  let n = 0, skipped = 0;
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
        if (Number(c) > 0) { skipped++; continue; }
        const calc = await calcNetFee(conn, r.id, ym);
        if (calc.total <= 0) { skipped++; continue; }
        const detail = calc.lines.map(l => {
          const segTxt = l.segments.map(s =>
            `${s.bandwidth}兆×${s.days}天`).join(' + ');
          return `【${l.line_name}】${segTxt}`;
        }).join(' ');
        const tenant = mode === 'property' ? r.owner_id : await rentedTenant(conn, r.id, oid);
        await conn.query(
          `INSERT INTO bills (org_id, source, room_id, tenant_id, period_start, period_end, due_date,
              amount, paid_amount, status, remark)
           VALUES (?, 'network', ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
          [oid, r.id, tenant, start, end, ym + '-10', calc.total,
           `网费：${detail}（按 ${calc.daysInMonth} 天折算，单价 ¥${calc.lines[0] ? calc.lines[0].price : 0}/兆）`]);
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
  if (!n) return res.json({ msg: `没有需要生成的账单${skipped ? `（${skipped} 项已存在或不满足条件）` : ''}` });
  return res.json({ msg: `本次共生成 ${n} 条${label}账单${skipped ? `，跳过 ${skipped} 项` : ''}` });
}));
/* 租房：某房间生效合同的租客 id */
async function rentedTenant(conn, roomId, oid) {
  const [cs] = await conn.query(
    "SELECT tenant_id FROM contracts WHERE room_id = ? AND org_id = ? AND status = 'active' LIMIT 1", [roomId, oid]);
  return cs[0] ? cs[0].tenant_id : null;
}

router.post('/bills', auth, h(async (req, res) => {
  const B = req.body || {};
  const allowed = { rental: ['rental', 'utility', 'network'], hotel: ['hotel'], property: ['property', 'network'] };
  const list = allowed[req.mode];
  const source = list.includes(B.source) ? B.source : list[0];
  const [r] = await pool.query(
    `INSERT INTO bills (org_id, source, room_id, tenant_id, contract_id, order_id, period_start, period_end,
        due_date, amount, paid_amount, status, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
    [req.orgId, source, B.room_id ? Number(B.room_id) : null, B.tenant_id ? Number(B.tenant_id) : null,
     B.contract_id ? Number(B.contract_id) : null, B.order_id ? Number(B.order_id) : null,
     B.period_start, B.period_end, B.due_date || today(), Number(B.amount) || 0, B.remark || '手动添加']);
  const [rows] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(normBill(rows[0]));
}));
router.post('/bills/:id/pay', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const b = rows[0];
  if (!b) return res.status(400).json({ error: '账单不存在' });
  const amt = Number(req.body.amount) || 0;
  const paid = Math.min(Number(b.amount), Number(b.paid_amount) + amt);
  const status = paid >= Number(b.amount) ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  const pay_date = req.body.pay_date || today();
  await pool.query(
    `UPDATE bills SET paid_amount = ?, status = ?, pay_method = COALESCE(?, pay_method), pay_date = ?
      WHERE id = ? AND org_id = ?`,
    [paid, status, req.body.pay_method || null, pay_date, b.id, req.orgId]);
  const [after] = await pool.query('SELECT * FROM bills WHERE id = ? AND org_id = ?', [b.id, req.orgId]);
  res.json(normBill(after[0]));
}));
router.delete('/bills/:id', auth, h(async (req, res) => {
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
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [Number(B.room_id), req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  const [[{ c }]] = await pool.query(
    'SELECT COUNT(*) AS c FROM meters WHERE room_id = ? AND org_id = ? AND month = ?',
    [Number(B.room_id), req.orgId, B.month]);
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
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [Number(B.room_id), req.orgId]);
  const room = rooms[0];
  if (!room) return res.status(400).json({ error: '房间不存在' });
  const [[{ c }]] = await pool.query(
    'SELECT COUNT(*) AS c FROM meters WHERE room_id = ? AND org_id = ? AND month = ? AND id <> ?',
    [Number(B.room_id), req.orgId, B.month, req.params.id]);
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
  sql += ' ORDER BY l.room_id, l.id';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(l => ({ ...l, bandwidth: Number(l.bandwidth) || 0 })));
}));
router.post('/netLines', auth, h(async (req, res) => {
  const B = req.body || {};
  const roomId = Number(B.room_id);
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE id = ? AND org_id = ?', [roomId, req.orgId]);
  if (!rooms[0]) return res.status(400).json({ error: '房间不存在' });
  const bw = Number(B.bandwidth);
  if (!Number.isFinite(bw) || bw <= 0) return res.status(400).json({ error: '请填写有效的带宽兆数' });
  const startDate = B.start_date || today();
  const [r] = await pool.query(
    `INSERT INTO room_net_lines (org_id, room_id, line_name, bandwidth, start_date, status, stop_date, remark, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    [req.orgId, roomId, B.line_name || '默认线路', bw, startDate, B.remark || '', nowStr()]);
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/netLines/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!rows[0]) return res.status(400).json({ error: '线路不存在' });
  const line = rows[0];
  const sets = [];
  const params = [];
  if (B.line_name !== undefined) { sets.push('line_name = ?'); params.push(B.line_name || line.line_name); }
  if (B.remark !== undefined) { sets.push('remark = ?'); params.push(B.remark || ''); }
  if (sets.length) {
    await pool.query(`UPDATE room_net_lines SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`,
      [...params, req.params.id, req.orgId]);
  }
  const [after] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(after[0]);
}));
router.post('/netLines/:id/stop', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const line = rows[0];
  if (!line) return res.status(400).json({ error: '线路不存在' });
  if (line.status === 'stopped') return res.status(400).json({ error: '线路已停用' });
  const stopDate = req.body.stop_date || today();
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
  const [rows] = await pool.query('SELECT * FROM room_net_lines WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  const line = rows[0];
  if (!line) return res.status(400).json({ error: '线路不存在' });
  if (line.status === 'active') return res.status(400).json({ error: '线路已启用' });
  const startDate = req.body.start_date || today();
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
  sql += ' ORDER BY ch.change_date DESC, ch.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(c => ({ ...c,
    delta: (Number(c.new_bandwidth) || 0) - (Number(c.old_bandwidth) || 0) })));
}));
router.post('/netChanges', auth, h(async (req, res) => {
  const B = req.body || {};
  const roomId = Number(B.room_id);
  const lineId = Number(B.line_id);
  if (!Number.isFinite(lineId)) return res.status(400).json({ error: '请选择宽带线路' });
  const [lines] = await pool.query(
    'SELECT * FROM room_net_lines WHERE id = ? AND org_id = ? AND room_id = ?', [lineId, req.orgId, roomId]);
  const line = lines[0];
  if (!line) return res.status(400).json({ error: '宽带线路不存在' });
  if (line.status !== 'active') return res.status(400).json({ error: '该线路已停用，不能变更带宽' });
  const oldBw = Number(line.bandwidth) || 0;
  const newBw = Number(B.new_bandwidth);
  if (!Number.isFinite(newBw) || newBw < 0) return res.status(400).json({ error: '请填写有效的带宽兆数' });
  if (newBw === oldBw) return res.status(400).json({ error: '带宽未变化' });
  const changeDate = B.change_date || today();
  if (line.start_date && changeDate < String(line.start_date)) {
    return res.status(400).json({ error: '变更日期不能早于线路开通日' });
  }
  const change_type = newBw > oldBw ? 'add' : 'reduce';
  const [r] = await pool.query(
    `INSERT INTO net_changes (org_id, room_id, line_id, change_date, change_type, old_bandwidth, new_bandwidth,
        remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.orgId, roomId, lineId, changeDate, change_type, oldBw, newBw, B.remark || '', nowStr()]);
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
  await pool.query('DELETE FROM net_changes WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ ok: true,
    warn: '已删除变更记录。如该记录为最后一条，线路当前带宽未自动回滚，请到网络管理手动调整。' });
}));

/* 网费预估（租房/物业）：房间月费 = 各启用线路费用之和，单价取主体设置 */
router.get('/netfee', auth, h(async (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const dim = daysInMonth(month);
  const { building_id } = req.query;
  let sql = `SELECT * FROM rooms WHERE org_id = ? AND ${FEATURES[req.mode].billable}`;
  const params = [req.orgId];
  if (building_id) { sql += ' AND building_id = ?'; params.push(Number(building_id)); }
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
  sql += ' ORDER BY r.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));
router.post('/repairs', auth, h(async (req, res) => {
  const B = req.body || {};
  if (!B.title) return res.status(400).json({ error: '报修标题不能为空' });
  const [r] = await pool.query(
    "INSERT INTO repairs (org_id, room_id, title, content, status, handler, handle_note, created_at) VALUES (?, ?, ?, ?, 'pending', '', '', ?)",
    [req.orgId, Number(B.room_id), B.title, B.content || '', nowStr()]);
  const [rows] = await pool.query('SELECT * FROM repairs WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/repairs/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [r] = await pool.query(
    'UPDATE repairs SET status = ?, handler = ?, handle_note = ? WHERE id = ? AND org_id = ?',
    [B.status || 'pending', B.handler || '', B.handle_note || '', req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '报修记录不存在' });
  const [rows] = await pool.query('SELECT * FROM repairs WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/repairs/:id', auth, h(async (req, res) => {
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
  const [rows] = await pool.query(
    `SELECT c.*, r.room_no, b.name AS building_name, t.name AS owner_name, t.phone AS owner_phone
       FROM complaints c LEFT JOIN rooms r ON r.id = c.room_id
       LEFT JOIN buildings b ON b.id = r.building_id LEFT JOIN tenants t ON t.id = c.owner_id
      WHERE ${cond.join(' AND ')} ORDER BY c.id DESC`, params);
  res.json(rows);
}));
router.post('/complaints', auth, h(async (req, res) => {
  const B = req.body || {};
  if (!B.title) return res.status(400).json({ error: '标题不能为空' });
  const [r] = await pool.query(
    `INSERT INTO complaints (org_id, room_id, owner_id, type, title, content, status, handler, handle_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', '', '', ?)`,
    [req.orgId, B.room_id ? Number(B.room_id) : 0, B.owner_id ? Number(B.owner_id) : null,
     ['投诉', '建议', '咨询', '其他'].includes(B.type) ? B.type : '投诉',
     B.title, B.content || '', nowStr()]);
  const [rows] = await pool.query('SELECT * FROM complaints WHERE id = ? AND org_id = ?', [r.insertId, req.orgId]);
  res.json(rows[0]);
}));
router.put('/complaints/:id', auth, h(async (req, res) => {
  const B = req.body || {};
  const [r] = await pool.query(
    'UPDATE complaints SET status = ?, handler = ?, handle_note = ? WHERE id = ? AND org_id = ?',
    [B.status || 'pending', B.handler || '', B.handle_note || '', req.params.id, req.orgId]);
  if (!r.affectedRows) return res.status(400).json({ error: '记录不存在' });
  const [rows] = await pool.query('SELECT * FROM complaints WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json(rows[0]);
}));
router.delete('/complaints/:id', auth, h(async (req, res) => {
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
  res.json(rows.map(r => ({
    ...r, is_system: Number(r.is_system), user_count: Number(r.user_count),
    pages: byRole[r.id] || []
  })));
}));
router.post('/roles', authMode, h(async (req, res) => {
  const B = req.body || {};
  const code = String(B.code || '').trim();
  const name = String(B.name || '').trim();
  if (!code || !name) return res.status(400).json({ error: '角色编码与名称不能为空' });
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/.test(code)) {
    return res.status(400).json({ error: '角色编码需以字母开头，仅含字母/数字/下划线（≤30位）' });
  }
  if (req.level === 'super') {
    const level = ['super', 'admin', 'staff'].includes(B.level) ? B.level : 'staff';
    const [[dup]] = await shared.query('SELECT COUNT(*) AS c FROM roles WHERE org_id IS NULL AND code = ?', [code]);
    if (Number(dup.c) > 0) return res.status(400).json({ error: '角色编码已存在' });
    const [r] = await shared.query(
      'INSERT INTO roles (org_id, code, name, description, level) VALUES (NULL, ?, ?, ?, ?)',
      [code, name, String(B.description || ''), level]);
    const [rows] = await shared.query('SELECT * FROM roles WHERE id = ?', [r.insertId]);
    return res.json({ ...rows[0], pages: [] });
  }
  /* 主管理员只能在本主体建 staff 角色 */
  const orgId = req.orgId;
  const [[dup]] = await shared.query('SELECT COUNT(*) AS c FROM roles WHERE org_id = ? AND code = ?', [orgId, code]);
  if (Number(dup.c) > 0) return res.status(400).json({ error: '角色编码已存在' });
  const [r] = await shared.query(
    'INSERT INTO roles (org_id, code, name, description, level) VALUES (?, ?, ?, ?, "staff")',
    [orgId, code, name, String(B.description || '')]);
  await setRolePages(r.insertId, B.pages);
  const [rows] = await shared.query('SELECT * FROM roles WHERE id = ?', [r.insertId]);
  res.json({ ...rows[0], pages: Array.isArray(B.pages) ? [...new Set(B.pages)] : [] });
}));
router.put('/roles/:id', authMode, h(async (req, res) => {
  const B = req.body || {};
  const [rs] = await shared.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  if (!rs.length) return res.status(400).json({ error: '角色不存在' });
  const role = rs[0];
  /* 主管理员只能改本主体自建角色 */
  if (req.level !== 'super' && role.org_id !== req.orgId) {
    return res.status(403).json({ error: '只能管理本系统角色' });
  }
  const name = String(B.name || '').trim();
  if (!name) return res.status(400).json({ error: '角色名称不能为空' });
  if (Number(role.is_system) || (req.level !== 'super' && role.org_id === null)) {
    await shared.query('UPDATE roles SET name = ?, description = ? WHERE id = ?',
      [name, String(B.description || ''), req.params.id]);
  } else {
    const code = String(B.code || '').trim();
    if (!code) return res.status(400).json({ error: '角色编码不能为空' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/.test(code)) {
      return res.status(400).json({ error: '角色编码需以字母开头，仅含字母/数字/下划线（≤30位）' });
    }
    const [[dup]] = await shared.query(
      'SELECT COUNT(*) AS c FROM roles WHERE code = ? AND org_id <=> ? AND id <> ?',
      [code, role.org_id, req.params.id]);
    if (Number(dup.c) > 0) return res.status(400).json({ error: '角色编码已存在' });
    await shared.query('UPDATE roles SET code = ?, name = ?, description = ? WHERE id = ?',
      [code, name, String(B.description || ''), req.params.id]);
    /* 自建角色可配置页面权限（内置/全局角色不设） */
    if (role.org_id !== null) await setRolePages(req.params.id, B.pages);
  }
  const [rows] = await shared.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  const pages = role.org_id !== null && !Number(role.is_system)
    ? (await shared.query('SELECT page FROM role_permissions WHERE role_id = ?', [req.params.id]))[0].map(p => p.page)
    : [];
  res.json({ ...rows[0], pages });
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
  const [perms] = await shared.query('SELECT user_id, page FROM user_permissions');
  const byUser = {};
  for (const p of perms) (byUser[p.user_id] = byUser[p.user_id] || []).push(p.page);
  const [rolePerms] = await shared.query(
    `SELECT r.code, rp.page FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      WHERE r.org_id = ?`, [req.orgId]);
  const byRole = {};
  for (const p of rolePerms) (byRole[p.code] = byRole[p.code] || []).push(p.page);
  res.json(rows.map(u => ({
    ...u, pages: byUser[u.id] || [], role_pages: byRole[u.role] || []
  })));
}));
router.post('/users', authMode, orgAdminOnly, h(async (req, res) => {
  const B = req.body || {};
  if (!B.username || !B.password) return res.status(400).json({ error: '用户名与密码不能为空' });
  const role = String(B.role || 'staff');
  const [meta] = await shared.query(
    'SELECT * FROM roles WHERE code = ? AND (org_id = ? OR (org_id IS NULL AND level = "staff")) LIMIT 1',
    [role, req.orgId]);
  if (!meta.length) return res.status(400).json({ error: '角色不存在' });
  /* 账号名同系统内唯一（跨系统/跨主体可重名，按系统独立运营） */
  const [[dup]] = await shared.query(
    'SELECT COUNT(*) AS c FROM users WHERE mode = ? AND username = ?', [req.mode, B.username]);
  if (Number(dup.c) > 0) return res.status(400).json({ error: '该用户名在本系统已存在' });
  const [r] = await shared.query(
    'INSERT INTO users (username, password, real_name, role, mode, org_id) VALUES (?, ?, ?, ?, ?, ?)',
    [B.username, hashPassword(B.password), B.real_name || '', role, req.mode, req.orgId]);
  if (Array.isArray(B.pages)) {
    for (const p of [...new Set(B.pages)]) {
      await shared.query('INSERT IGNORE INTO user_permissions (user_id, page) VALUES (?, ?)', [r.insertId, p]);
    }
  }
  const [rows] = await shared.query(
    `SELECT u.id, u.username, u.real_name, u.role, u.mode, u.org_id,
            COALESCE(rc.name, rb.name) AS role_name
       FROM users u
       LEFT JOIN roles rc ON rc.code = u.role AND rc.org_id = u.org_id
       LEFT JOIN roles rb ON rb.code = u.role AND rb.org_id IS NULL
      WHERE u.id = ?`, [r.insertId]);
  res.json(rows[0]);
}));
router.put('/users/:id', authMode, orgAdminOnly, h(async (req, res) => {
  const B = req.body || {};
  const [us] = await shared.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!us.length) return res.status(400).json({ error: '用户不存在' });
  const target = us[0];
  if (target.org_id !== req.orgId || target.role === 'admin') {
    return res.status(403).json({ error: '只能管理本系统员工' });
  }
  const role = String(B.role || 'staff');
  const [meta] = await shared.query(
    'SELECT * FROM roles WHERE code = ? AND (org_id = ? OR (org_id IS NULL AND level = "staff")) LIMIT 1',
    [role, req.orgId]);
  if (!meta.length) return res.status(400).json({ error: '角色不存在' });
  await shared.query('UPDATE users SET real_name = ?, role = ? WHERE id = ?',
    [B.real_name || '', role, req.params.id]);
  if (B.password) {
    await shared.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(B.password), req.params.id]);
  }
  await shared.query('DELETE FROM user_permissions WHERE user_id = ?', [req.params.id]);
  if (Array.isArray(B.pages)) {
    for (const p of [...new Set(B.pages)]) {
      await shared.query('INSERT IGNORE INTO user_permissions (user_id, page) VALUES (?, ?)', [req.params.id, p]);
    }
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
