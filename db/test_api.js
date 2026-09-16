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
    const WY = r.body.token;
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
    check('员工接口忽略个人追加权限(不再生效)', r.status === 200, '');
    opLogin = await login('op' + 'emp' + ts, 'test123456', 'rental');
    check('员工实际权限=仅角色权限(meters,rooms)', opLogin.status === 200 && opLogin.body.pages.sort().join() === 'meters,rooms', JSON.stringify(opLogin.body.pages));
    /* 操作权限细分（动作级）：员工写操作按角色 ops 精确到新增/编辑/删除 */
    r = await call(A, 'PUT', '/roles/' + roleA.id, { code: roleCode, name: '运营', pages: ['rooms', 'bills'], ops: ['room_add'] });
    check('角色配置操作权限 room_add', r.status === 200 && Array.isArray(r.body.ops) && r.body.ops.includes('room_add'), JSON.stringify(r.body.ops));
    opLogin = await login('op' + 'emp' + ts, 'test123456', 'rental');
    check('员工登录返回操作权限', opLogin.status === 200 && opLogin.body.ops.includes('room_add'), JSON.stringify(opLogin.body.ops));
    r = await call(opLogin.body.token, 'POST', '/rooms', {});
    check('有 room_add 的员工写房源放行(缺参数报 400)', r.status === 400, JSON.stringify(r.body));
    r = await call(opLogin.body.token, 'PUT', '/rooms/' + roomA, { room_no: '101' });
    check('无 room_edit 的员工编辑房源被拦截 403', r.status === 403, JSON.stringify(r.body));
    r = await call(opLogin.body.token, 'POST', '/meters', {});
    check('无 meter_add 的员工写抄表被拦截 403', r.status === 403, JSON.stringify(r.body));
    r = await call(A, 'PUT', '/roles/' + roleA.id, { code: roleCode, name: '运营', pages: ['rooms', 'bills'], ops: [] });
    opLogin = await login('op' + 'emp' + ts, 'test123456', 'rental');
    r = await call(opLogin.body.token, 'POST', '/rooms', {});
    check('移除操作权限后员工写被拦截 403', r.status === 403, JSON.stringify(r.body));
    r = await call(A, 'DELETE', '/users/' + opEmpId);
    check('清理运营员工', r.status === 200 && r.body.ok, '');
    r = await call(A, 'DELETE', '/roles/' + roleA.id);
    check('清理运营角色(级联权限)', r.status === 200 && r.body.ok, '');
    r = await call(A, 'GET', '/roles');
    check('删除角色后权限表无残留', !r.body.some(x => x.code === roleCode), '');

    console.log('== 6d. 物业企业 / 企业员工（企业管理 Tab，照片上传，权限隔离）==');
    const compName = '测试' + '科技' + ts;
    r = await call(PROP, 'POST', '/tenants', { name: compName, contact: '王经理', license_no: '91330000TEST' });
    check('物业建企业(电话非必填)', r.status === 200 && r.body.id && r.body.emp_count === 0, JSON.stringify(r.body));
    const compId = r.body.id;
    r = await call(PROP, 'GET', '/tenants');
    const compInList = r.body.find(x => x.id === compId);
    check('企业列表含联系人/证件/员工数', compInList && compInList.contact === '王经理' && compInList.license_no === '91330000TEST' && Number(compInList.emp_count) === 0, JSON.stringify(compInList));
    /* 上传接口：1x1 红色 png base64 */
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = await call(PROP, 'POST', '/upload', { data: 'data:image/png;base64,' + pngB64 });
    check('上传照片返回URL', r.status === 200 && /^\/uploads\/org-\d+\//.test(r.body.url), JSON.stringify(r.body));
    const photoUrl = r.body.url;
    r = await call(PROP, 'POST', '/upload', { data: 'data:text/plain;base64,' + Buffer.from('x').toString('base64') });
    check('非图片上传被拒', r.status === 400, JSON.stringify(r.body));
    /* 企业员工：company 自动匹配已有企业 */
    r = await call(PROP, 'POST', '/org-employees', {
      company: compName, name: '李四', id_number: 'H1001', phone: '855123', department: '财务部',
      position: '会计', card_no: 'CARD-01', photo_url: photoUrl, remark: '测试'
    });
    check('建企业员工(自动绑定企业)', r.status === 200 && r.body.owner_id === compId && r.body.photo_url === photoUrl, JSON.stringify(r.body));
    const empId = r.body.id;
    r = await call(PROP, 'GET', '/tenants');
    check('企业员工数统计=1', Number(r.body.find(x => x.id === compId).emp_count) === 1, JSON.stringify(r.body.find(x => x.id === compId)));
    r = await call(PROP, 'GET', '/org-employees');
    check('主管理员可见企业员工列表', r.status === 200 && r.body.some(e => e.id === empId && e.owner_name === compName), JSON.stringify(r.body));
    /* 未授权员工（内置 staff 角色，无 orgemp 页面权限）：不可见 */
    r = await call(PROP, 'POST', '/users', { username: 'nop' + 'emp' + ts, password: 'test123456', role: 'staff' });
    check('建未授权员工(内置staff角色)', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const noPermId = r.body.id;
    const noPermLogin = await login('nop' + 'emp' + ts, 'test123456', 'property');
    r = await call(noPermLogin.body.token, 'GET', '/org-employees');
    check('未授权员工访问企业员工被拒', r.status === 403, JSON.stringify(r.body));
    r = await call(PROP, 'DELETE', '/users/' + noPermId);
    check('清理未授权员工', r.status === 200 && r.body.ok, '');
    /* 物业主管理员给员工角色授权 orgemp（角色权限） */
    r = await call(PROP, 'POST', '/roles', { code: 'empview' + ts, name: '企业查看', pages: ['orgemp'] });
    check('建企业查看角色(带orgemp权限)', r.status === 200 && r.body.pages.includes('orgemp'), JSON.stringify(r.body));
    const viewRoleId = r.body.id;
    r = await call(PROP, 'POST', '/users', { username: 'emp' + 'staff' + ts, password: 'test123456', role: 'empview' + ts, pages: [] });
    check('建授权员工(挂企业查看角色)', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const empStaffId = r.body.id;
    const empStaffLogin = await login('emp' + 'staff' + ts, 'test123456', 'property');
    check('授权员工登录含orgemp权限', empStaffLogin.status === 200 && empStaffLogin.body.pages.includes('orgemp'), JSON.stringify(empStaffLogin.body.pages));
    r = await call(empStaffLogin.body.token, 'GET', '/org-employees');
    check('授权员工可读企业员工列表', r.status === 200 && r.body.some(e => e.id === empId), '');
    r = await call(empStaffLogin.body.token, 'POST', '/org-employees', { company: compName, name: '越权' });
    check('授权员工不可写(仅主管理员可增删改)', r.status === 403, JSON.stringify(r.body));
    /* 清理：删除员工/角色/企业员工；企业有员工时删除被拒 */
    r = await call(PROP, 'DELETE', '/tenants/' + compId);
    check('企业有员工时删除被拒', r.status === 400 && /企业员工/.test(r.body.error), JSON.stringify(r.body));
    r = await call(PROP, 'DELETE', '/org-employees/' + empId);
    check('删除企业员工', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/tenants/' + compId);
    check('删除企业(员工已清)', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/users/' + empStaffId);
    check('清理授权员工', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/roles/' + viewRoleId);
    check('清理企业查看角色', r.status === 200 && r.body.ok, '');

    console.log('== 6e. 企业管理员（物业：只读本企业数据，删除企业级联清理账号）==');
    const caUser = 'biz' + String(ts).slice(-6);
    r = await call(PROP, 'POST', '/tenants', { name: '测试' + '一公司' + ts });
    check('建企业A', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const compA = r.body.id;
    r = await call(PROP, 'POST', '/tenants', { name: '测试' + '二公司' + ts });
    check('建企业B', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const compB = r.body.id;
    r = await call(PROP, 'POST', '/buildings', { name: '企业楼', address: '路2' });
    const bld = r.body.id;
    r = await call(PROP, 'POST', '/rooms', { building_id: bld, room_no: 'A01', floor: 1, area: 30, room_type: '办公室', status: 'vacant', owner_id: compA, property_fee: 2 });
    check('企业A名下房产', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const roomA2 = r.body.id;
    r = await call(PROP, 'POST', '/rooms', { building_id: bld, room_no: 'B01', floor: 1, area: 30, room_type: '办公室', status: 'vacant', owner_id: compB, property_fee: 2 });
    check('企业B名下房产', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const roomB2 = r.body.id;
    r = await call(PROP, 'POST', '/org-employees', { company: '测试' + '一公司' + ts, name: '甲员工' });
    const empA = r.body.id;
    r = await call(PROP, 'POST', '/org-employees', { company: '测试' + '二公司' + ts, name: '乙员工' });
    const empB = r.body.id;
    r = await call(PROP, 'POST', '/bills', { room_id: roomA2, source: 'network', amount: 50, period_start: ym + '-01', period_end: ym + '-28', due_date: addDays(5) });
    check('企业A房产生成网费账单', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const billA = r.body.id;
    /* 设置 / 重置企业管理员账号 */
    r = await call(PROP, 'POST', '/tenants/' + compA + '/company-admin',
      { username: caUser, real_name: '一号管理员', password: 'ca123456' });
    check('为企业设置管理员账号', r.status === 200 && r.body.username === caUser, JSON.stringify(r.body));
    r = await call(PROP, 'POST', '/tenants/' + compA + '/company-admin',
      { username: caUser, real_name: '一号管理员', password: 'ca654321' });
    check('重复设置=重置密码', r.status === 200 && r.body.username === caUser, JSON.stringify(r.body));
    r = await call(PROP, 'GET', '/tenants');
    check('企业列表带管理员账号', r.body.find(x => x.id === compA).admin_username === caUser, JSON.stringify(r.body.find(x => x.id === compA)));
    /* 企业管理员导航页面参与角色配置：建角色（页面权限）+ 分配 */
    r = await call(PROP, 'POST', '/roles', { code: 'ca' + ts + 'a', name: '企业查看',
      pages: ['dashboard', 'properties', 'owners', 'meters', 'network', 'bills', 'complaints', 'repairs'] });
    check('建企业管理员查看角色(页面权限)', r.status === 200 && r.body.pages.includes('owners'), JSON.stringify(r.body.pages));
    const caRoleA = r.body;
    r = await call(PROP, 'GET', '/users');
    const caUserRow = r.body.find(x => x.username === caUser);
    check('员工管理可找到企业管理员账号', !!caUserRow, '');
    r = await call(PROP, 'PUT', '/users/' + caUserRow.id, { role: caRoleA.code });
    check('给企业管理员分配查看角色', r.status === 200 && r.body.role === caRoleA.code, JSON.stringify(r.body));
    /* 企业管理员登录（物业窗口） */
    r = await login(caUser, 'ca654321', 'property');
    check('企业管理员登录物业窗口', r.status === 200 && r.body.level === 'company_admin' && r.body.company_id === compA && r.body.pages.includes('owners'), JSON.stringify(r.body).slice(0, 120));
    const CA = r.body.token;
    /* 数据隔离：只读本企业 */
    r = await call(CA, 'GET', '/tenants');
    check('企业管理员仅见本企业', r.status === 200 && r.body.length === 1 && r.body[0].id === compA, JSON.stringify(r.body.map(t => t.id)));
    r = await call(CA, 'GET', '/org-employees');
    check('企业管理员仅见本企业员工', r.status === 200 && r.body.length === 1 && r.body[0].id === empA, JSON.stringify(r.body.map(e => e.id)));
    r = await call(CA, 'GET', '/rooms');
    check('企业管理员仅见本企业房产', r.status === 200 && r.body.length === 1 && r.body[0].id === roomA2, JSON.stringify(r.body.map(x => x.id)));
    r = await call(CA, 'GET', '/bills');
    check('企业管理员仅见本企业账单', r.status === 200 && r.body.length === 1 && r.body[0].id === billA, JSON.stringify(r.body.map(b => b.id)));
    r = await call(CA, 'GET', '/stats?f=room,owner,bill,network,repair,complaint,meter');
    check('企业管理员统计仅本企业', r.status === 200 && Number(r.body.total_rooms) === 1 && Number(r.body.owner_count) === 1 && Number(r.body.emp_count) === 1, JSON.stringify({ total_rooms: r.body.total_rooms, owner_count: r.body.owner_count, emp_count: r.body.emp_count }));
    /* 只读：写接口全部 403 */
    const caWrites = [
      ['POST', '/tenants', { name: '越权企业' }],
      ['POST', '/org-employees', { company: '测试' + '一公司' + ts, name: '越权' }],
      ['POST', '/rooms', { building_id: bld, room_no: 'X01', status: 'vacant' }],
      ['POST', '/bills', { room_id: roomA2, source: 'network', amount: 9 }],
      ['POST', '/bills/' + billA + '/pay', { paid_amount: 1 }],
      ['POST', '/meters', { room_id: roomA2, month: ym, water_curr: 10, elec_curr: 10 }],
      ['POST', '/repairs', { room_id: roomA2, title: 't' }],
      ['POST', '/complaints', { room_id: roomA2, type: '投诉', title: 't' }],
      ['POST', '/netLines', { room_id: roomA2, line_name: 'L1', bandwidth: 5 }],
      ['PUT', '/settings', { rate: 9 }],
      ['POST', '/tenants/' + compA + '/company-admin', { username: 'hack', password: '123456' }]
    ];
    for (const [m, p, b] of caWrites) {
      r = await call(CA, m, p, b);
      check('企业管理员只读(' + m + ' ' + p + ')', r.status === 403, JSON.stringify(r.body).slice(0, 80));
    }
    r = await call(CA, 'GET', '/users');
    check('企业管理员不能访问员工管理', r.status === 403, '');
    r = await call(CA, 'GET', '/roles');
    check('企业管理员不能访问角色管理', r.status === 403, '');
    /* 清理并验证级联删除管理员账号 */
    r = await call(PROP, 'DELETE', '/org-employees/' + empA);
    check('清理企业A员工', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/bills/' + billA);
    check('清理企业A账单', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/rooms/' + roomA2);
    check('清理企业A房产', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/tenants/' + compA);
    check('删除企业A(级联清理管理员账号)', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    r = await call(PROP, 'DELETE', '/roles/' + caRoleA.id);
    check('清理企业查看角色(账号已级联删除)', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    r = await login(caUser, 'ca654321', 'property');
    check('删除企业后管理员账号失效', r.status === 400 && /用户名或密码错误/.test(r.body.error), JSON.stringify(r.body));
    r = await call(PROP, 'DELETE', '/org-employees/' + empB);
    r = await call(PROP, 'DELETE', '/rooms/' + roomB2);
    r = await call(PROP, 'DELETE', '/tenants/' + compB);
    r = await call(PROP, 'DELETE', '/buildings/' + bld);
    check('清理企业B及楼栋', r.status === 200 && r.body.ok, '');

    console.log('== 6f. 宽带报装 / 加兆 / 减兆 上报（企业管理员提交，主管理员审批执行）==');
    r = await call(PROP, 'POST', '/tenants', { name: '测试' + '三公司' + ts });
    check('建企业C', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const compC = r.body.id;
    r = await call(PROP, 'POST', '/tenants', { name: '测试' + '四公司' + ts });
    check('建企业D', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const compD = r.body.id;
    r = await call(PROP, 'POST', '/buildings', { name: '上报楼', address: '路3' });
    const bld2 = r.body.id;
    r = await call(PROP, 'POST', '/rooms', { building_id: bld2, room_no: 'C01', floor: 1, area: 30, room_type: '办公室', status: 'vacant', owner_id: compC, property_fee: 2 });
    check('企业C名下房产', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const roomC = r.body.id;
    r = await call(PROP, 'POST', '/rooms', { building_id: bld2, room_no: 'D01', floor: 1, area: 30, room_type: '办公室', status: 'vacant', owner_id: compD, property_fee: 2 });
    check('企业D名下房产', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const roomD = r.body.id;
    const caUser2 = 'ca2' + String(ts).slice(-6);
    r = await call(PROP, 'POST', '/tenants/' + compC + '/company-admin',
      { username: caUser2, real_name: '三号管理员', password: 'ca654321' });
    check('为企业C设置管理员账号', r.status === 200 && r.body.username === caUser2, JSON.stringify(r.body));
    r = await login(caUser2, 'ca654321', 'property');
    check('企业C管理员登录', r.status === 200 && r.body.level === 'company_admin' && r.body.company_id === compC, JSON.stringify(r.body).slice(0, 120));
    const CA2 = r.body.token;
    /* 权限管理：企业管理员上报类写操作按角色 ops 控制（netline_bandwidth / repair_add 白名单） */
    r = await call(CA2, 'POST', '/netRequests', { type: 'install', room_id: roomC, bandwidth: 10, reason: '办公报装' });
    check('未分配角色：企业管理员宽带上报被拒 403', r.status === 403, JSON.stringify(r.body));
    r = await call(CA2, 'POST', '/repairs', { room_id: roomC, title: '网络报修：断网', content: '测试' });
    check('未分配角色：企业管理员报修被拒 403', r.status === 403, JSON.stringify(r.body));
    /* 主管理员建角色（宽带上报 + 网络报修）并分配给企业管理员 */
    r = await call(PROP, 'POST', '/roles', { code: 'ca' + ts, name: '企业上报',
      pages: ['dashboard', 'properties', 'owners', 'meters', 'network', 'bills', 'complaints', 'repairs'],
      ops: ['netline_bandwidth', 'repair_add'] });
    check('建企业管理员上报角色', r.status === 200 && r.body.ops.includes('netline_bandwidth') && r.body.pages.includes('network'), JSON.stringify(r.body));
    const caRole = r.body;
    r = await call(PROP, 'GET', '/users');
    const ca2User = r.body.find(x => x.username === caUser2);
    check('员工管理可找到企业管理员账号', !!ca2User, '');
    r = await call(PROP, 'PUT', '/users/' + ca2User.id, { role: caRole.code });
    check('给企业管理员分配上报角色', r.status === 200 && r.body.role === caRole.code, JSON.stringify(r.body));
    r = await login(caUser2, 'ca654321', 'property');
    check('企业C管理员登录带角色页面/操作权限', r.status === 200 && r.body.ops.includes('netline_bandwidth') && r.body.ops.includes('repair_add') && r.body.pages.includes('network'), JSON.stringify(r.body.ops));
    /* 提交申请：本企业 → 200；他企业 → 403 */
    r = await call(CA2, 'POST', '/netRequests', { type: 'install', room_id: roomC, bandwidth: 10, reason: '办公报装' });
    check('企业管理员提交报装申请', r.status === 200 && r.body.status === 'pending' && r.body.type === 'install', JSON.stringify(r.body));
    const reqInstall = r.body.id;
    r = await call(CA2, 'POST', '/netRequests', { type: 'install', room_id: roomD, bandwidth: 5 });
    check('他企业房产提交申请被拒', r.status === 403, JSON.stringify(r.body));
    r = await call(CA2, 'GET', '/netRequests');
    check('企业管理员仅见本企业申请', r.status === 200 && r.body.length === 1 && r.body[0].id === reqInstall, JSON.stringify(r.body.map(x => x.id)));
    r = await call(CA2, 'PUT', '/netRequests/' + reqInstall, { action: 'approve' });
    check('企业管理员不能审批', r.status === 403, JSON.stringify(r.body));
    r = await call(WY, 'POST', '/netRequests', { type: 'install', room_id: roomC, bandwidth: 5 });
    check('物业员工不能提交申请', r.status === 403, JSON.stringify(r.body));
    /* 主管理员审批：报装 → 建线路 */
    r = await call(PROP, 'GET', '/netRequests');
    check('主管理员可见全部申请', r.status === 200 && r.body.some(x => x.id === reqInstall), '');
    r = await call(PROP, 'PUT', '/netRequests/' + reqInstall, { action: 'approve', handle_note: '审批通过' });
    check('审批报装并执行', r.status === 200 && r.body.status === 'done' && r.body.line_id, JSON.stringify(r.body));
    const lineC = r.body.line_id;
    r = await call(PROP, 'GET', '/netLines?room_id=' + roomC);
    check('报装后线路已创建', r.status === 200 && r.body.length === 1 && Number(r.body[0].bandwidth) === 10, JSON.stringify(r.body));
    r = await call(PROP, 'PUT', '/netRequests/' + reqInstall, { action: 'approve' });
    check('重复审批被拒', r.status === 400, JSON.stringify(r.body));
    /* 加兆申请 → 审批 → 带宽增加 */
    r = await call(CA2, 'POST', '/netRequests', { type: 'add', room_id: roomC, line_id: lineC, delta: 5, reason: '加兆' });
    check('企业管理员提交加兆申请', r.status === 200 && r.body.type === 'add', JSON.stringify(r.body));
    const reqAdd = r.body.id;
    r = await call(PROP, 'PUT', '/netRequests/' + reqAdd, { action: 'approve' });
    check('审批加兆并执行', r.status === 200 && r.body.status === 'done' && Number(r.body.new_bandwidth) === 15, JSON.stringify(r.body));
    r = await call(PROP, 'GET', '/netLines?room_id=' + roomC);
    check('加兆后带宽=15', r.status === 200 && Number(r.body[0].bandwidth) === 15, JSON.stringify(r.body));
    /* 减兆：减到负 → 400；正常 → 驳回 */
    r = await call(CA2, 'POST', '/netRequests', { type: 'reduce', room_id: roomC, line_id: lineC, delta: 20 });
    check('减兆超过当前带宽被拒', r.status === 400, JSON.stringify(r.body));
    r = await call(CA2, 'POST', '/netRequests', { type: 'reduce', room_id: roomC, line_id: lineC, delta: 3 });
    check('企业管理员提交减兆申请', r.status === 200 && r.body.type === 'reduce', JSON.stringify(r.body));
    const reqReduce = r.body.id;
    r = await call(PROP, 'PUT', '/netRequests/' + reqReduce, { action: 'reject', handle_note: '暂不调整' });
    check('审批驳回', r.status === 200 && r.body.status === 'rejected', JSON.stringify(r.body));
    r = await call(PROP, 'GET', '/netLines?room_id=' + roomC);
    check('驳回后带宽不变=15', r.status === 200 && Number(r.body[0].bandwidth) === 15, JSON.stringify(r.body));
    /* 网络报修：有 repair_add 的企业管理员可提交，且仅限本企业房产 */
    r = await call(CA2, 'POST', '/repairs', { room_id: roomC, title: '网络报修：断网', content: '持续掉线' });
    check('有报修权限的企业管理员提交报修', r.status === 200 && r.body.id && String(r.body.title).startsWith('网络报修'), JSON.stringify(r.body));
    const repC = r.body.id;
    r = await call(CA2, 'POST', '/repairs', { room_id: roomD, title: '网络报修：慢' });
    check('他企业房产报修被拒 403', r.status === 403, JSON.stringify(r.body));
    r = await call(PROP, 'GET', '/repairs');
    check('主管理员可见企业管理员报修单', r.status === 200 && r.body.some(x => x.id === repC), '');
    r = await call(PROP, 'DELETE', '/repairs/' + repC);
    check('清理企业C报修', r.status === 200 && r.body.ok, '');
    /* 清理 */
    r = await call(PROP, 'DELETE', '/rooms/' + roomC);
    check('清理企业C房产', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/rooms/' + roomD);
    r = await call(PROP, 'DELETE', '/tenants/' + compC);
    r = await call(PROP, 'DELETE', '/tenants/' + compD);
    r = await call(PROP, 'DELETE', '/buildings/' + bld2);
    check('清理上报测试数据', r.status === 200 && r.body.ok, '');
    r = await call(PROP, 'DELETE', '/roles/' + caRole.id);
    check('清理企业上报角色(账号已级联删除)', r.status === 200 && r.body.ok, JSON.stringify(r.body));

    console.log('== 7. 员工页面权限 ==');
    /* 新模型：员工页面权限全部来自角色；建临时角色+员工验证 */
    r = await call(RENT, 'POST', '/roles', { code: 'pg' + ts, name: '看房', pages: ['rooms'] });
    check('建临时查看角色(rooms)', r.status === 200 && r.body.pages.includes('rooms'), JSON.stringify(r.body));
    const pgRoleId = r.body.id;
    r = await call(RENT, 'POST', '/users', { username: 'pg' + 'emp' + ts, password: 'test123456', role: 'pg' + ts });
    check('建员工挂查看角色', r.status === 200 && r.body.id, JSON.stringify(r.body));
    const pgEmpId = r.body.id;
    const pgLogin = await login('pg' + 'emp' + ts, 'test123456', 'rental');
    r = await call(pgLogin.body.token, 'GET', '/rooms');
    check('员工可访问授权页面(房源)', r.status === 200, r.status + '');
    r = await call(pgLogin.body.token, 'PUT', '/settings', { rate: 9 });
    check('员工不能修改设置', r.status === 403, r.status + '');
    r = await call(pgLogin.body.token, 'GET', '/users');
    check('员工不能访问员工管理', r.status === 403, r.status + '');
    r = await call(RENT, 'DELETE', '/users/' + pgEmpId);
    check('清理临时员工', r.status === 200 && r.body.ok, '');
    r = await call(RENT, 'DELETE', '/roles/' + pgRoleId);
    check('清理临时角色', r.status === 200 && r.body.ok, '');

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
