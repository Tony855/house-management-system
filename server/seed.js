'use strict';
/* ==================================================================
 * 种子数据（多租户 · 三系统差异化）
 * 共享库：orgs / roles / users / settings / user_permissions
 * 模式库：仅本系统用到的业务表，数据按 org_id 归属
 * 执行：node server/seed.js        全新演示（账号 + 业务演示数据）
 *       node server/seed.js core   仅账号体系（业务数据为空）
 * ================================================================== */
const { shared, getPool } = require('./db');
const { hashPassword, today, nowStr, addDays, addMonths } = require('./util');

const MODES = ['rental', 'hotel', 'property'];
const ORG_NAMES = { rental: '经营主体', hotel: '经营主体', property: '经营主体' };
const ADMIN = { rental: ['admin_r', 'admin_r123', '租房管理员'], hotel: ['admin_h', 'admin_h123', '酒店管理员'],
  property: ['admin_p', 'admin_p123', '物业管理员'] };

async function seedShared() {
  const [[{ c }]] = await shared.query('SELECT COUNT(*) AS c FROM users');
  if (Number(c) > 0) return false;
  const conn = await shared.getConnection();
  try {
    await conn.beginTransaction();

    /* 内置角色（org_id = NULL） */
    const roles = [
      ['super', '超级管理员', '全局：开通经营主体、监控系统', 'super', 1],
      ['admin', '主管理员', '经营主体负责人：管理本主体全部业务与员工', 'admin', 1],
      ['staff', '员工', '普通员工：按授予的页面权限访问', 'staff', 1]
    ];
    for (const [code, name, desc, level, isSys] of roles) {
      await conn.query('INSERT INTO roles (org_id, code, name, description, level, is_system) VALUES (NULL, ?, ?, ?, ?, ?)',
        [code, name, desc, level, isSys]);
    }

    /* 三个默认经营主体（每系统各一个） */
    const orgIds = {};
    for (const mode of MODES) {
      const [r] = await conn.query('INSERT INTO orgs (name, mode) VALUES (?, ?)', [ORG_NAMES[mode], mode]);
      orgIds[mode] = r.insertId;
    }

    /* 超管 + 三系统主管理员 + 两员工 */
    const users = [
      ['superadmin', 'super123', '超级管理员', 'super', null, null],
      ['admin_r', 'admin_r123', '租房管理员', 'admin', 'rental', orgIds.rental],
      ['admin_h', 'admin_h123', '酒店管理员', 'admin', 'hotel', orgIds.hotel],
      ['admin_p', 'admin_p123', '物业管理员', 'admin', 'property', orgIds.property],
      ['staff', 'staff123', '前台小王', 'staff', 'rental', orgIds.rental],
      ['wy', 'wy123', '物业老李', 'staff', 'property', orgIds.property]
    ];
    const ids = {};
    for (const [u, p, n, r, m, o] of users) {
      const [res] = await conn.query(
        'INSERT INTO users (username, password, real_name, role, mode, org_id) VALUES (?, ?, ?, ?, ?, ?)',
        [u, hashPassword(p), n, r, m, o]);
      ids[u] = res.insertId;
    }
    for (const mode of MODES) {
      await conn.query('UPDATE orgs SET admin_user_id = ? WHERE id = ?',
        [ids[ADMIN[mode][0]], orgIds[mode]]);
    }

    /* 每主体一份独立设置（酒店单价不使用，仅给默认值） */
    for (const mode of MODES) {
      await conn.query(
        'INSERT INTO settings (org_id, currency, rate, net_price_per_mb, water_price, elec_price) VALUES (?, ?, ?, ?, ?, ?)',
        [orgIds[mode], 'USD', 7.2, 1.0, 4.5, 1.0]);
    }

    /* 全局配置（超管级）：默认显示登录入口选择，隐藏后直达租房窗口 */
    await conn.query('INSERT INTO app_config (k, v) VALUES (?, ?), (?, ?)',
      ['login_selector', 'show', 'login_default', 'rental']);

    /* 员工页面权限 */
    const staffPages = {
      staff: ['dashboard', 'rooms', 'tenants', 'contracts', 'meters', 'network', 'bills', 'repairs', 'buildings'],
      wy:    ['dashboard', 'properties', 'owners', 'meters', 'network', 'bills', 'complaints', 'repairs']
    };
    for (const [u, pages] of Object.entries(staffPages)) {
      for (const page of pages) {
        await conn.query('INSERT INTO user_permissions (user_id, page) VALUES (?, ?)', [ids[u], page]);
      }
    }

    await conn.commit();
    return orgIds;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ---------------- 租房 ---------------- */
async function seedRental(p, oid) {
  const t = today(), ym = t.slice(0, 7);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const [name, addr] of [['A栋', '幸福路 1 号'], ['B栋', '幸福路 3 号']]) {
      await conn.query('INSERT INTO buildings (org_id, name, address) VALUES (?, ?, ?)', [oid, name, addr]);
    }
    const tids = [];
    for (const tn of [['张三', '男', '13800000001'], ['李四', '女', '13800000002'],
                      ['王五', '男', '13800000003'], ['赵六', '女', '13800000004']]) {
      const [r] = await conn.query('INSERT INTO tenants (org_id, name, gender, phone) VALUES (?, ?, ?, ?)',
        [oid, tn[0], tn[1], tn[2]]);
      tids.push(r.insertId);
    }
    /* 房间：月租/押金 + 已出租房间带水电单价（带宽改由线路表管理） */
    const rooms = [
      ['101', 1, 25, '一居室', 1800, 1800, 'rented', 4.5, 1],
      ['102', 1, 30, '一居室', 2200, 2200, 'vacant', 4.5, 1],
      ['201', 2, 45, '两居室', 3200, 3200, 'vacant', 4.5, 1],
      ['202', 2, 45, '两居室', 3200, 3200, 'maintenance', 4.5, 1],
      ['101', 1, 20, '单间', 1500, 1500, 'rented', 4.5, 1],
      ['102', 1, 20, '单间', 1500, 1500, 'vacant', 4.5, 1],
      ['201', 2, 35, '一居室', 2600, 2600, 'vacant', 4.5, 1],
      ['202', 2, 35, '一居室', 2600, 2600, 'vacant', 4.5, 1]
    ];
    const rids = [];
    for (const i in rooms) {
      const b = i < 4 ? 1 : 2;
      const [no, fl, area, type, rent, dep, st, wp, ep] = rooms[i];
      const [r] = await conn.query(
        `INSERT INTO rooms (org_id, building_id, room_no, floor, area, rent, deposit, status, room_type,
            water_price, elec_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oid, b, no, fl, area, rent, dep, st, type, wp, ep]);
      rids.push(r.insertId);
    }
    /* 宽带线路：101 号（一栋）100 兆、101 号（二栋）50 兆，各建一条默认线路 */
    const [l1] = await conn.query(
      `INSERT INTO room_net_lines (org_id, room_id, line_name, bandwidth, start_date, status, remark, created_at)
       VALUES (?, ?, '默认线路', 100, ?, 'active', '主宽带', ?)`,
      [oid, rids[0], addDays(t, -120), nowStr()]);
    const [l2] = await conn.query(
      `INSERT INTO room_net_lines (org_id, room_id, line_name, bandwidth, start_date, status, remark, created_at)
       VALUES (?, ?, '默认线路', 50, ?, 'active', '主宽带', ?)`,
      [oid, rids[4], addDays(t, -300), nowStr()]);
    const contracts = [
      ['HT20240001', rids[0], tids[0], addDays(t, -120), addDays(t, 245), 1800, 1800, 1, addDays(t, -120)],
      ['HT20240002', rids[4], tids[2], addDays(t, -300), addDays(t, 25), 1500, 1500, 3, addDays(t, -300)]
    ];
    const cids = [];
    for (const c of contracts) {
      const [r] = await conn.query(
        `INSERT INTO contracts (org_id, contract_no, room_id, tenant_id, start_date, end_date, rent, deposit,
            pay_cycle, sign_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`, [oid, ...c]);
      cids.push(r.insertId);
    }
    /* 本月抄表（已出租两间） */
    for (const [rid, wp, ep] of [[rids[0], 20, 90], [rids[4], 15, 60]]) {
      await conn.query(
        `INSERT INTO meters (org_id, room_id, month, water_prev, water_curr, water_usage, water_fee,
            elec_prev, elec_curr, elec_usage, elec_fee)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oid, rid, ym, 100, 100 + wp, wp, round(wp * 4.5), 500, 500 + ep, ep, round(ep * 1)]);
    }
    await conn.query(
      `INSERT INTO net_changes (org_id, room_id, line_id, change_date, change_type, old_bandwidth, new_bandwidth,
          remark, created_at)
       VALUES (?, ?, ?, ?, 'add', 50, 100, '升级带宽', ?)`,
      [oid, rids[0], l1.insertId, addDays(t, -15), nowStr()]);
    /* 账单：租金 + 水电 + 网费 */
    const bills = [
      ['rental', rids[0], tids[0], cids[0], addDays(t, -30), addDays(t, -1), addDays(t, -30), 1800, 1800, 'paid', '微信', addDays(t, -28), '合同租金'],
      ['rental', rids[0], tids[0], cids[0], t, addDays(addMonths(t, 1), -1), t, 1800, 0, 'unpaid', '', null, '合同租金'],
      ['rental', rids[4], tids[2], cids[1], addDays(t, -90), addDays(t, -1), addDays(t, -90), 4500, 3000, 'partial', '支付宝', addDays(t, -85), '合同租金'],
      ['utility', rids[0], tids[0], null, t, addDays(addMonths(t, 1), -1), ym + '-10', 180, 0, 'unpaid', '', null, '水电'],
      ['network', rids[0], tids[0], null, t, addDays(addMonths(t, 1), -1), ym + '-10', 100, 0, 'unpaid', '', null, '网费']
    ];
    for (const b of bills) await insertBill(conn, oid, b);
    for (const [rid, title, content, st, handler, note] of [
      [rids[3], '墙面渗水', '卫生间外墙有渗水痕迹', 'processing', '前台小王', '已联系师傅'],
      [rids[7], '空调不制冷', '遥控器正常，但出风不凉', 'pending', '', '']]) {
      await conn.query(
        `INSERT INTO repairs (org_id, room_id, title, content, status, handler, handle_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [oid, rid, title, content, st, handler, note, nowStr()]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

/* ---------------- 酒店 ---------------- */
async function seedHotel(p, oid) {
  const t = today();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const [name, addr] of [['主楼', '海滨大道 8 号'], ['附楼', '海滨大道 10 号']]) {
      await conn.query('INSERT INTO buildings (org_id, name, address) VALUES (?, ?, ?)', [oid, name, addr]);
    }
    const tids = [];
    for (const tn of [['陈客', '男', '13900000001'], ['林客', '女', '13900000002'],
                      ['黄客', '男', '13900000003'], ['周客', '女', '13900000004']]) {
      const [r] = await conn.query('INSERT INTO tenants (org_id, name, gender, phone) VALUES (?, ?, ?, ?)',
        [oid, tn[0], tn[1], tn[2]]);
      tids.push(r.insertId);
    }
    const rooms = [
      ['101', 1, 25, '标准间', 120, 'vacant'], ['102', 1, 28, '标准间', 150, 'rented'],
      ['201', 2, 40, '大床房', 220, 'vacant'], ['202', 2, 40, '大床房', 220, 'maintenance'],
      ['101', 1, 18, '单人间', 100, 'vacant'], ['102', 1, 18, '单人间', 100, 'vacant'],
      ['201', 2, 38, '豪华大床房', 180, 'booked'], ['202', 2, 38, '豪华大床房', 180, 'vacant']
    ];
    const rids = [];
    for (const i in rooms) {
      const b = i < 4 ? 1 : 2;
      const [no, fl, area, type, dp, st] = rooms[i];
      const [r] = await conn.query(
        `INSERT INTO rooms (org_id, building_id, room_no, floor, area, day_price, deposit, status, room_type)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`, [oid, b, no, fl, area, dp, st, type]);
      rids.push(r.insertId);
    }
    const orders = [
      ['DD20240001', rids[1], tids[1], addDays(t, -1), addDays(t, 2), 3, 150, 450, 200, 'checked_in'],
      ['DD20240002', rids[6], tids[3], addDays(t, 3), addDays(t, 5), 2, 180, 360, 200, 'booked']
    ];
    for (const o of orders) {
      await conn.query(
        `INSERT INTO orders (org_id, order_no, room_id, guest_id, check_in_date, check_out_date, days,
            day_price, total, deposit, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oid, ...o, nowStr()]);
    }
    for (const [rid, title, content, st, handler, note] of [
      [rids[3], '热水器故障', '客房无热水', 'processing', '前台', '已安排维修'],
      [rids[7], '电视无信号', '开机蓝屏', 'pending', '', '']]) {
      await conn.query(
        `INSERT INTO repairs (org_id, room_id, title, content, status, handler, handle_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [oid, rid, title, content, st, handler, note, nowStr()]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

/* ---------------- 物业 ---------------- */
async function seedProperty(p, oid) {
  const t = today(), ym = t.slice(0, 7);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const [name, addr] of [['阳光花园', '园区路 1 号'], ['翠湖小区', '园区路 9 号']]) {
      await conn.query('INSERT INTO buildings (org_id, name, address) VALUES (?, ?, ?)', [oid, name, addr]);
    }
    const tids = [];
    for (const tn of [['张业主', '男', '13700000001'], ['李业主', '女', '13700000002'],
                      ['王业主', '男', '13700000003'], ['赵业主', '女', '13700000004']]) {
      const [r] = await conn.query('INSERT INTO tenants (org_id, name, gender, phone) VALUES (?, ?, ?, ?)',
        [oid, tn[0], tn[1], tn[2]]);
      tids.push(r.insertId);
    }
    const owners = [1, 2, 1, 2, 3, 3, 4, 4];
    const pf = [80, 100, 150, 150, 70, 70, 120, 120];
    const bw = [200, 100, 100, 100, 50, 50, 100, 0];
    const status = ['rented', 'vacant', 'rented', 'maintenance', 'rented', 'rented', 'rented', 'vacant'];
    const base = [['101', 1, 25], ['102', 1, 30], ['201', 2, 45], ['202', 2, 45],
                  ['101', 1, 20], ['102', 1, 20], ['201', 2, 35], ['202', 2, 35]];
    const rids = [];
    for (const i in base) {
      const b = i < 4 ? 1 : 2;
      const [no, fl, area] = base[i];
      const [r] = await conn.query(
        `INSERT INTO rooms (org_id, building_id, room_no, floor, area, status, room_type, owner_id,
            property_fee, water_price, elec_price)
         VALUES (?, ?, ?, ?, ?, ?, '住宅', ?, ?, 4.5, 1)`,
        [oid, b, no, fl, area, status[i], owners[i], pf[i]]);
      rids.push(r.insertId);
    }
    /* 宽带线路：有带宽的房间各建一条默认线路（101 一栋带升级记录，101 二栋带加兆记录） */
    const lineByRoom = {};
    for (const i in bw) {
      if (!bw[i]) continue;
      const start = (i == 0) ? addDays(t, -60) : (i == 4 ? addDays(t, -30) : t);
      const [lr] = await conn.query(
        `INSERT INTO room_net_lines (org_id, room_id, line_name, bandwidth, start_date, status, remark, created_at)
         VALUES (?, ?, '默认线路', ?, ?, 'active', '主宽带', ?)`,
        [oid, rids[i], bw[i], start, nowStr()]);
      lineByRoom[rids[i]] = lr.insertId;
    }
    /* [房间, 水上期, 水本期, 电上期, 电本期] */
    for (const m of [[rids[0], 100, 120, 500, 550], [rids[2], 200, 220, 800, 850]]) {
      const [rid, wpv, wcv, epv, ecv] = m;
      const wu = wcv - wpv, eu = ecv - epv;
      await conn.query(
        `INSERT INTO meters (org_id, room_id, month, water_prev, water_curr, water_usage, water_fee,
            elec_prev, elec_curr, elec_usage, elec_fee)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oid, rid, ym, wpv, wcv, wu, round(wu * 4.5), epv, ecv, eu, round(eu * 1)]);
    }
    for (const nc of [[rids[0], addDays(t, -15), 100, 200], [rids[4], addDays(t, -8), 30, 50]]) {
      const [rid, dt, ob, nb] = nc;
      await conn.query(
        `INSERT INTO net_changes (org_id, room_id, line_id, change_date, change_type, old_bandwidth, new_bandwidth,
            remark, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oid, rid, lineByRoom[rid], dt, nb > ob ? 'add' : 'reduce', ob, nb, '带宽变更', nowStr()]);
    }
    const bills = [
      ['property', rids[0], tids[0], null, t, addDays(addMonths(t, 1), -1), ym + '-10', 220, 220, 'paid', '微信', addDays(t, -2), '物业费+水电'],
      ['property', rids[4], tids[2], null, t, addDays(addMonths(t, 1), -1), ym + '-10', 160, 0, 'unpaid', '', null, '物业费+水电']
    ];
    for (const b of bills) await insertBill(conn, oid, b);
    for (const c of [[rids[2], tids[0], '投诉', '楼上噪音扰民', '夜间声响较大', 'pending', '', ''],
                     [rids[4], tids[2], '建议', '增设快递柜', '建议增设智能快递柜', 'processing', '物业老李', '已上报业委会']]) {
      const [rid, owner, type, title, content, st, handler, note] = c;
      await conn.query(
        `INSERT INTO complaints (org_id, room_id, owner_id, type, title, content, status, handler, handle_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [oid, rid, owner, type, title, content, st, handler, note, nowStr()]);
    }
    for (const [rid, title, content, st] of [
      [rids[3], '楼道灯损坏', '2 楼楼道灯不亮', 'processing'],
      [rids[7], '门禁故障', '单元门刷卡无反应', 'pending']]) {
      await conn.query(
        `INSERT INTO repairs (org_id, room_id, title, content, status, handler, handle_note, created_at)
         VALUES (?, ?, ?, ?, ?, '', '', ?)`, [oid, rid, title, content, st, nowStr()]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

function round(n) { return Math.round(n * 100) / 100; }
async function insertBill(conn, oid, b) {
  const [source, room_id, tenant_id, contract_id, ps, pe, due, amount, paid, status, method, payDate, remark] = b;
  await conn.query(
    `INSERT INTO bills (org_id, source, room_id, tenant_id, contract_id, order_id, period_start, period_end,
        due_date, amount, paid_amount, status, pay_method, pay_date, remark)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [oid, source, room_id, tenant_id, contract_id || null, ps, pe, due, amount, paid, status, method, payDate, remark]);
}

async function main() {
  const coreOnly = process.argv.includes('core');
  const orgIds = await seedShared();
  if (!orgIds) { console.log('共享库已有数据，跳过。如需重建请先执行 schema.sql。'); return; }
  console.log('共享库（经营主体/角色/账号/设置）种子写入完成。');
  if (coreOnly) {
    console.log('core 模式：仅账号体系，业务数据为空。');
  } else {
    await seedRental(getPool('rental'), orgIds.rental);
    await seedHotel(getPool('hotel'), orgIds.hotel);
    await seedProperty(getPool('property'), orgIds.property);
    console.log('三系统业务演示数据写入完成。');
  }
  console.log('演示账号：');
  console.log('  超管 superadmin/super123');
  console.log('  租房 admin_r/admin_r123 · 酒店 admin_h/admin_h123 · 物业 admin_p/admin_p123');
  console.log('  员工 staff/staff123（租房）· wy/wy123（物业）');
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
