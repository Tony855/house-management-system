'use strict';
/* ==================================================================
 * 多租户 · 三系统差异化  API 端到端测试（Node 18+ 全局 fetch）
 *
 * 前置：服务已启动（默认 http://localhost:16088），数据库为 core 种子
 *       （mysql < db/schema.sql && node server/seed.js core）
 * 运行：node db/test_api.js
 *
 * 测试会开通两个临时租房主体做隔离验证，结束时自动级联删除，不污染默认主体。
 * ================================================================== */
const BASE = process.env.BASE || 'http://localhost:16088/api';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \u2713 ' + m); };
const bad = (m, extra) => { fail++; console.log('  \u2717 ' + m + (extra ? '  => ' + extra : '')); };
function check(m, cond, extra) { cond ? ok(m) : bad(m, extra); }

async function call(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (username, password, mode) => {
  const r = await call(null, 'POST', '/login', { username, password, ...(mode ? { mode } : {}) });
  return r;
};

const ISO = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ISO(d); };

(async () => {
  const createdOrgs = [];
  try {
    console.log('== 1. 登录入口强绑定（三系统独立运营）==');
    let r = await login('superadmin', 'super123', 'hotel');
    check('超管从系统入口登录被拒(通用错误)', r.status === 400 && /用户名或密码错误/.test(r.body.error), JSON.stringify(r.body));
    r = await login('superadmin', 'super123');
    check('超管无入口登录被拒(通用错误)', r.status === 400 && /用户名或密码错误/.test(r.body.error), JSON.stringify(r.body));
    r = await login('staff', 'staff123', 'rental');
    check('租房员工从租房窗口登录成功', r.status === 200 && r.body.level === 'staff' && r.body.mode === 'rental', JSON.stringify(r.body));
    r = await login('staff', 'staff123');
    check('员工无入口(通用)登录被拒', r.status === 400 && /用户名或密码错误/.test(r.body.error), JSON.stringify(r.body));
    r = await login('staff', 'staff123', 'property');
    check('租房员工从物业窗口登录被拒(不泄露归属)', r.status === 400 && /用户名或密码错误/.test(r.body.error) && !/租房|物业/.test(r.body.error), JSON.stringify(r.body));
    r = await login('wy', 'wy123', 'property');
    check('物业员工从物业窗口登录成功', r.status === 200 && r.body.level === 'staff' && r.body.mode === 'property', JSON.stringify(r.body));
    r = await login('wy', 'wy123', 'rental');
    check('物业员工从租房窗口登录被拒(不泄露归属)', r.status === 400 && /用户名或密码错误/.test(r.body.error), JSON.stringify(r.body));
    r = await login('admin_r', 'admin_r123', 'property');
    check('主管理员从错误系统入口被拒(通用错误)', r.status === 400 && /用户名或密码错误/.test(r.body.error) && !/租房|物业/.test(r.body.error), JSON.stringify(r.body));
    r = await login('superadmin', 'wrong-pass', 'super');
    check('错误密码被拒', r.status === 400 && /用户名或密码错误/.test(r.body.error), JSON.stringify(r.body));

    r = await login('superadmin', 'super123', 'super');
    check('超管登录成功', r.status === 200 && r.body.level === 'super', JSON.stringify(r.body));
    const SUPER = r.body.token;
    r = await login('admin_h', 'admin_h123', 'hotel');
    check('酒店主管理员登录', r.status === 200 && r.body.mode === 'hotel', JSON.stringify(r.body));
    const HOTEL = r.body.token;
    r = await login('admin_r', 'admin_r123', 'rental');
    const RENT = r.body.token;
    r = await login('staff', 'staff123', 'rental');
    check('租房员工登录成功并带页面权限', r.status === 200 && r.body.level === 'staff' && Array.isArray(r.body.pages), JSON.stringify(r.body));
    const STAFF = r.body.token;
    r = await login('admin_p', 'admin_p123', 'property');
    check('物业主管理员登录', r.status === 200 && r.body.mode === 'property', JSON.stringify(r.body));
    const PROP = r.body.token;

    console.log('== 2. 超级管理员职责（仅监控 + 主体管理）==');
    r = await call(SUPER, 'GET', '/monitor');
    check('监控可访问且聚合三系统', r.status === 200 && r.body.systems && r.body.systems.rental && r.body.systems.hotel && r.body.systems.property, JSON.stringify(r.body).slice(0, 160));
    check('监控含每系统主体明细', r.status === 200 && r.body.orgs && Array.isArray(r.body.orgs.rental) && Array.isArray(r.body.orgs.hotel) && Array.isArray(r.body.orgs.property), '缺少 orgs 明细');
    r = await call(SUPER, 'GET', '/rooms');
    check('超管不能访问业务接口', r.status === 403, r.status + '');
    r = await call(SUPER, 'GET', '/users');
    check('超管不直接管理员工(无 /users)', r.status === 403, r.status + '');

    console.log('== 2b. 全局配置（登录页公开读，仅超管可写）==');
    r = await call(null, 'GET', '/app-config');
    check('公开读取默认 显示入口/默认租房', r.status === 200 && r.body.login_selector === 'show' && r.body.login_default === 'rental', JSON.stringify(r.body));
    r = await call(RENT, 'PUT', '/app-config', { login_selector: 'hide' });
    check('主管理员不能修改全局配置', r.status === 403, r.status + '');
    r = await call(SUPER, 'PUT', '/app-config', { login_selector: 'hide', login_default: 'hotel' });
    check('超管开启隐藏+默认酒店', r.status === 200 && r.body.login_selector === 'hide' && r.body.login_default === 'hotel', JSON.stringify(r.body));
    r = await call(null, 'GET', '/app-config');
    check('公开读取到已保存配置', r.status === 200 && r.body.login_selector === 'hide' && r.body.login_default === 'hotel', JSON.stringify(r.body));
    r = await call(SUPER, 'PUT', '/app-config', { login_selector: 'show' });
    check('超管恢复显示入口', r.status === 200 && r.body.login_selector === 'show', JSON.stringify(r.body));
    r = await call(SUPER, 'PUT', '/app-config', { login_default: 'rental' });
    check('恢复默认入口为租房(清理测试痕迹)', r.status === 200 && r.body.login_default === 'rental', JSON.stringify(r.body));

    console.log('== 3. 开通两个租房主体 ==');
    const ts = Date.now().toString().slice(-7);
    for (const tag of ['A', 'B']) {
      r = await call(SUPER, 'POST', '/orgs', {
        mode: 'rental', name: '测试主体' + tag + '-' + ts,
        username: 't' + tag.toLowerCase() + ts, password: 'test123456', real_name: tag + '经理'
      });
      check('开通主体 ' + tag, r.status === 200 && r.body.org_id, JSON.stringify(r.body));
      createdOrgs.push(r.body.org_id);
    }
    r = await call(SUPER, 'GET', '/orgs');
    check('主体列表含新主体', createdOrgs.every(id => r.body.some(o => o.id === id)), '');
    r = await call(SUPER, 'POST', '/orgs', { mode: 'rental', name: '重复账号', username: 't' + 'a' + ts, password: 'test123456' });
    check('重复管理员账号被拒', r.status === 400 && /已存在/.test(r.body.error), JSON.stringify(r.body));

    const la = await login('t' + 'a' + ts, 'test123456', 'rental');
    const lb = await login('t' + 'b' + ts, 'test123456', 'rental');
    const A = la.body.token, B = lb.body.token;
    check('两主体管理员分别登录', la.status === 200 && lb.status === 200 && la.body.org_id !== lb.body.org_id, '');

    console.log('== 4. 酒店能力裁剪（无水电/网费/合同/投诉）==');
    for (const p of ['/contracts', '/meters', '/netChanges', '/complaints']) {
      const x = await call(HOTEL, 'GET', p);
      check('酒店 ' + p + ' 返回 404', x.status === 404 && /不提供该功能/.test(x.body.error), x.status + ' ' + JSON.stringify(x.body));
    }
    r = await call(HOTEL, 'GET', '/orders');
    check('酒店保留订单', r.status === 200 && Array.isArray(r.body), r.status + '');
    r = await call(HOTEL, 'GET', '/settings');
    check('酒店设置 prices=false（无单价）', r.status === 200 && r.body.prices === false, JSON.stringify(r.body));
    r = await call(HOTEL, 'PUT', '/settings', { currency: 'USD', rate: 7.2, water_price: 99 });
    check('酒店提交单价被忽略', r.status === 200 && r.body.prices === false, '');

    console.log('== 5. 主体 A 内跑租房完整业务 ==');
    r = await call(A, 'POST', '/buildings', { name: 'A栋', address: '路1' });
    const bldA = r.body.id;
    r = await call(A, 'POST', '/rooms', { building_id: bldA, room_no: '101', floor: 1, area: 25, room_type: '一居室', rent: 1000, deposit: 1000, water_price: 4.5, elec_price: 1, status: 'vacant' });
    const roomA = r.body.id;
    check('主体A 建房间', r.status === 200 && roomA, JSON.stringify(r.body));
    r = await call(A, 'POST', '/tenants', { name: '张三', gender: '男', phone: '0123' });
    const tnA = r.body.id;
    r = await call(A, 'POST', '/contracts', { room_id: roomA, tenant_id: tnA, start_date: addDays(-5), end_date: addDays(360), rent: 1000, deposit: 1000, pay_cycle: 1, sign_date: addDays(-5) });
    check('主体A 新签合同(房间转出租)', r.status === 200 && r.body.status === 'active', JSON.stringify(r.body));
    /* 宽带线路：两条启用线路（100 + 50），网费=150兆×单价；均为当月1日开通以验证整月计费 */
    const ym = new Date().toISOString().slice(0, 7);
    const m1 = ym + '-01';
    r = await call(A, 'POST', '/netLines', { room_id: roomA, line_name: '主宽带', bandwidth: 100, start_date: m1 });
    const lineA1 = r.body.id;
    check('主体A 添加线路1(100兆)', r.status === 200 && Number(r.body.bandwidth) === 100, JSON.stringify(r.body));
    r = await call(A, 'POST', '/netLines', { room_id: roomA, line_name: '第二条', bandwidth: 50, start_date: m1 });
    const lineA2 = r.body.id;
    check('主体A 添加线路2(50兆)', r.status === 200 && Number(r.body.bandwidth) === 50, JSON.stringify(r.body));
    r = await call(A, 'POST', '/netChanges', { room_id: roomA, line_id: lineA1, new_bandwidth: 120, change_date: m1, remark: '升级' });
    check('主体A 线路1加兆 100→120', r.status === 200 && Number(r.body.new_bandwidth) === 120 && Number(r.body.line_id) === lineA1, JSON.stringify(r.body));
    r = await call(A, 'POST', '/meters', { room_id: roomA, month: ym, water_prev: 0, water_curr: 10, elec_prev: 0, elec_curr: 100 });
    check('主体A 抄表(水45/电100)', r.status === 200 && Number(r.body.water_fee) === 45 && Number(r.body.elec_fee) === 100, JSON.stringify(r.body));
    r = await call(A, 'POST', '/bills/generate', { kind: 'all' });
    check('一键生成全部账单(含网费=120+50兆)', r.status === 200 && /3/.test(r.body.msg || ''), JSON.stringify(r.body));
    r = await call(A, 'GET', '/bills');
    const sources = r.body.map(x => x.source).sort();
    check('三类账单齐全(rental/utility/network)', sources.join() === 'network,rental,utility', sources.join());
    r = await call(A, 'GET', '/netfee?month=' + ym);
    const nf = r.body.list && r.body.list[0];
    check('网费带宽=两线路合计170兆', nf && Number(nf.bandwidth) === 170 && nf.lines.length === 2, JSON.stringify(nf && { bw: nf.bandwidth, lines: nf.lines.map(l => l.bandwidth) }));
    check('网费整月=满月费(各线路分段覆盖整月)', nf && Number(nf.month_fee) === Number(nf.full_month_fee)
      && nf.lines.every(l => l.segments.reduce((s, x) => s + x.days, 0) === nf.days_in_month),
      JSON.stringify(nf && { month_fee: nf.month_fee, full: nf.full_month_fee, lines: nf.lines.map(l => ({ n: l.line_name, days: l.segments.reduce((s, x) => s + x.days, 0) })) }));
    r = await call(A, 'POST', '/netLines/' + lineA2 + '/stop', { stop_date: addDays(-1) });
    check('停用线路2', r.status === 200 && r.body.status === 'stopped', JSON.stringify(r.body));
    r = await call(A, 'GET', '/netfee?month=' + ym);
    const nf2 = r.body.list && r.body.list[0];
    check('停用后带宽=120兆(线路2不计)', nf2 && Number(nf2.bandwidth) === 120, JSON.stringify(nf2 && { bw: nf2.bandwidth }));

    console.log('== 6. 主体间数据 / 设置 / 角色 / 员工 完全隔离 ==');
    r = await call(B, 'GET', '/buildings');
    check('主体B 看不到 A 的楼栋', r.status === 200 && r.body.length === 0, JSON.stringify(r.body));
    r = await call(B, 'GET', '/rooms');
    check('主体B 看不到 A 的房间', r.status === 200 && r.body.length === 0, JSON.stringify(r.body));
    r = await call(A, 'PUT', '/settings', { currency: 'USD', rate: 8, net_price_per_mb: 1, water_price: 4.5, elec_price: 1 });
    check('主体A 修改汇率', r.status === 200 && Number(r.body.rate) === 8, JSON.stringify(r.body));
    r = await call(B, 'GET', '/settings');
    check('主体B 汇率仍为默认 7.2（设置独立）', Number(r.body.rate) === 7.2, JSON.stringify(r.body));
    r = await call(A, 'POST', '/roles', { code: 'cleaner_a', name: '保洁A' });
    check('主体A 自建员工角色', r.status === 200 && r.body.level === 'staff', JSON.stringify(r.body));
    r = await call(B, 'GET', '/roles');
    check('主体B 看不到 A 的自建角色', !r.body.some(x => x.code === 'cleaner_a'), JSON.stringify(r.body.map(x => x.code)));
    r = await call(A, 'POST', '/users', { username: 'emp' + 'a' + ts, password: 'emp123456', real_name: 'A员工', role: 'staff', pages: ['dashboard', 'rooms'] });
    check('主体A 新增员工', r.status === 200 && r.body.id, JSON.stringify(r.body));
    r = await call(B, 'GET', '/users');
    check('主体B 员工列表不含 A 的员工', !r.body.some(x => x.username === 'emp' + 'a' + ts), '');
    r = await call(A, 'GET', '/roles');
    check('主管理员只见员工级角色(无 super/admin)', r.body.every(x => x.level === 'staff'), JSON.stringify(r.body.map(x => x.level)));

    console.log('== 6b. 员工账号名：同系统内唯一，跨系统可重名 ==');
    r = await call(A, 'POST', '/users', { username: 'xiao' + 'zhang', password: 'test123456', real_name: '张一', role: 'staff', pages: ['rooms'] });
    check('主体A 建员工「小张」成功', r.status === 200 && r.body.id, JSON.stringify(r.body));
    r = await call(B, 'POST', '/users', { username: 'xiao' + 'zhang', password: 'test123456', real_name: '张二', role: 'staff', pages: ['rooms'] });
    check('同系统(租房)另一主体建同名被拒', r.status === 400 && /已存在/.test(r.body.error), JSON.stringify(r.body));
    r = await call(PROP, 'POST', '/users', { username: 'xiao' + 'zhang', password: 'test123456', real_name: '张三', role: 'staff', pages: ['properties'] });
    check('跨系统(物业)建同名员工成功', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const propEmpId = r.body.id;
    r = await call(PROP, 'DELETE', '/users/' + propEmpId);
    check('清理物业同名员工', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    r = await call(HOTEL, 'POST', '/users', { username: 'h' + 'emp' + ts, password: 'test123456', real_name: '酒店员工', role: 'staff', pages: ['dashboard', 'rooms'] });
    check('酒店主管理员建员工', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const hEmpId = r.body.id;
    r = await login('h' + 'emp' + ts, 'test123456', 'hotel');
    check('酒店员工从酒店窗口登录成功', r.status === 200 && r.body.mode === 'hotel' && r.body.level === 'staff', '');
    r = await login('h' + 'emp' + ts, 'test123456', 'rental');
    check('酒店员工从租房窗口登录被拒(不泄露归属)', r.status === 400 && /用户名或密码错误/.test(r.body.error), '');
    r = await call(HOTEL, 'DELETE', '/users/' + hEmpId);
    check('清理酒店员工', r.status === 200 && r.body.ok, JSON.stringify(r.body));

    console.log('== 6c. 角色页面权限（主管理员配置，员工继承，主体隔离）==');
    const roleCode = 'op' + ts;
    r = await call(A, 'POST', '/roles', { code: roleCode, name: '运营', pages: ['rooms', 'bills'] });
    check('主体A 建角色并配置权限', r.status === 200 && Array.isArray(r.body.pages) && r.body.pages.includes('rooms') && r.body.pages.includes('bills'), JSON.stringify(r.body));
    r = await call(A, 'GET', '/roles');
    const roleA = r.body.find(x => x.code === roleCode);
    check('主体A 角色列表含权限', !!roleA && roleA.pages.sort().join() === 'bills,rooms', JSON.stringify(roleA));
    r = await call(B, 'GET', '/roles');
    check('主体B 看不到 A 的自建角色权限', !r.body.some(x => x.code === roleCode), JSON.stringify(r.body.map(x => x.code)));
    r = await call(A, 'POST', '/users', { username: 'op' + 'emp' + ts, password: 'test123456', real_name: '运营员工', role: roleCode });
    check('主体A 建员工挂运营角色(无个人权限)', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const opEmpId = r.body.id;
    r = await call(A, 'GET', '/users');
    const opEmp = r.body.find(x => x.id === opEmpId);
    check('员工接口返回角色权限', opEmp && opEmp.role_pages.sort().join() === 'bills,rooms' && opEmp.pages.length === 0, JSON.stringify(opEmp && { rp: opEmp.role_pages, pp: opEmp.pages }));
    let opLogin = await login('op' + 'emp' + ts, 'test123456', 'rental');
    check('员工登录继承角色权限', opLogin.status === 200 && opLogin.body.pages.sort().join() === 'bills,rooms', JSON.stringify(opLogin.body.pages));
    r = await call(A, 'PUT', '/roles/' + roleA.id, { code: roleCode, name: '运营', pages: ['rooms', 'meters'] });
    check('修改角色权限(rooms/bills → rooms/meters)', r.status === 200 && r.body.pages.sort().join() === 'meters,rooms', JSON.stringify(r.body));
    opLogin = await login('op' + 'emp' + ts, 'test123456', 'rental');
    check('改角色权限后员工动态生效', opLogin.status === 200 && opLogin.body.pages.sort().join() === 'meters,rooms', JSON.stringify(opLogin.body.pages));
    r = await call(A, 'PUT', '/users/' + opEmpId, { real_name: '运营员工', role: roleCode, pages: ['bills'] });
    check('员工个人追加 bills 权限', r.status === 200, '');
    opLogin = await login('op' + 'emp' + ts, 'test123456', 'rental');
    check('员工实际权限=角色∪个人(bills,meters,rooms)', opLogin.status === 200 && opLogin.body.pages.sort().join() === 'bills,meters,rooms', JSON.stringify(opLogin.body.pages));
    r = await call(A, 'DELETE', '/users/' + opEmpId);
    check('清理运营员工', r.status === 200 && r.body.ok, '');
    r = await call(A, 'DELETE', '/roles/' + roleA.id);
    check('清理运营角色(级联权限)', r.status === 200 && r.body.ok, '');
    r = await call(A, 'GET', '/roles');
    check('删除角色后权限表无残留', !r.body.some(x => x.code === roleCode), '');

    console.log('== 7. 员工页面权限 ==');
    r = await call(STAFF, 'GET', '/rooms');
    check('员工可访问授权页面(房源)', r.status === 200, r.status + '');
    r = await call(STAFF, 'PUT', '/settings', { rate: 9 });
    check('员工不能修改设置', r.status === 403, r.status + '');
    r = await call(STAFF, 'GET', '/users');
    check('员工不能访问员工管理', r.status === 403, r.status + '');

    console.log('== 8. 级联删除主体 ==');
    for (const id of createdOrgs) {
      r = await call(SUPER, 'DELETE', '/orgs/' + id);
      check('级联删除主体 ' + id, r.status === 200 && r.body.ok, JSON.stringify(r.body));
    }
    r = await call(SUPER, 'GET', '/orgs');
    check('删除后主体列表已无临时主体', !createdOrgs.some(id => r.body.some(o => o.id === id)), '');
    const rentOrg = r.body.find(o => o.mode === 'rental' && o.id === 1);
    check('默认租房主体未受影响', rentOrg && rentOrg.room_count === 0, JSON.stringify(rentOrg));

  } catch (e) {
    bad('测试异常中断: ' + e.message, e.stack);
  } finally {
    /* 兜底清理：即使中途失败也尝试删除临时主体 */
    if (createdOrgs.length) {
      const su = await login('superadmin', 'super123', 'super');
      if (su.body.token) {
        for (const id of createdOrgs) {
          try { await call(su.body.token, 'DELETE', '/orgs/' + id); } catch {}
        }
      }
    }
    console.log('');
    console.log('结果: 通过 ' + pass + ' 项, 失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
