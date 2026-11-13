'use strict';
/* ==================================================================
 *  7. 登录（租房 / 酒店 / 物业 / 超级管理员 四个独立登录页）
 *    三系统独立运营：各系统管理员与员工均从本系统窗口登录，超管单独入口。
 * ================================================================== */
let LOGIN_MODE = null; /* 当前登录入口：rental / hotel / property / super */
const LOGIN_HASHES = { 'login-rental':1, 'login-hotel':1, 'login-property':1, 'login-super':1 };
/* 全局配置缓存（超管在「系统设置」中修改；登录页仅读取） */
let APP_CFG = null;
async function getAppConfig(){
  if (APP_CFG) return APP_CFG;
  try {
    const r = await fetch('/api/app-config');
    APP_CFG = await r.json();
  } catch(e){ APP_CFG = { login_selector: 'show', login_default: 'rental' }; }
  return APP_CFG;
}
async function showLogin(){
  const h = location.hash.slice(1);
  if (LOGIN_HASHES[h]){ LOGIN_MODE = h.slice(6); renderLoginPage(LOGIN_MODE); return; }
  LOGIN_MODE = null;
  /* 超管隐藏入口选择后：打开站点直达默认登录窗口（#login-xxx 仍可地址直达） */
  const cfg = await getAppConfig();
  if (cfg.login_selector === 'hide'){
    location.hash = LOGIN_HASHES['login-' + cfg.login_default]
      ? '#login-' + cfg.login_default : '#login-rental';
    return;
  }
  renderLoginHome();
}
function renderLoginHome(){
  const cur = getCurrency();
  const entry = (m, label, icon, desc) => `
    <div class="col"><div class="card shadow-sm h-100 text-center">
      <div class="card-body">
        <i class="bi bi-${icon} display-5 text-primary"></i>
        <h5 class="mt-2 mb-1">${label}登录</h5>
        <p class="text-muted small mb-2">${desc}</p>
        <a class="btn btn-sm btn-outline-primary" href="#login-${m}">进入登录</a>
      </div></div></div>`;
  $('#root').innerHTML = `
  <div class="d-flex align-items-center justify-content-center" style="height:100vh">
    <div class="w-100" style="max-width:860px">
      <div class="text-center mb-4">
        <h3 class="mb-1"><i class="bi bi-buildings text-primary"></i> 房屋管理系统</h3>
        <p class="text-muted">租房 · 酒店 · 物业，请选择对应的登录入口</p>
      </div>
      <div class="row g-3">
        ${entry('rental', '租房', 'house-door', '租房系统：房源 · 租客 · 合同 · 账单')}
        ${entry('hotel', '酒店', 'building', '酒店系统：房态 · 订单 · 房客 · 账单')}
        ${entry('property', '物业综合管理', 'hdd-network', '物业综合管理系统：房产 · 企业 · 水电抄表 · 网费')}
      </div>
    </div>
  </div>`;
}
async function renderLoginPage(m){
  const cfg = await getAppConfig();
  const isSuper = m === 'super';
  /* 仅超管入口预填初始超管账号；各系统窗口留空 */
  const defUser = isSuper ? 'superadmin' : '';
  const defPwd = isSuper ? 'super123' : '';
  $('#root').innerHTML = `
  <div class="d-flex align-items-center justify-content-center" style="height:100vh">
    <div class="card shadow" style="width:400px">
      <div class="card-body p-4">
        <h4 class="text-center mb-1"><i class="bi bi-${isSuper ? 'shield-lock' : 'buildings'} text-primary"></i>
          ${isSuper ? '超级管理员登录' : MODE_NAME[m] + '系统登录'}</h4>
        <p class="text-center text-muted small mb-3">
          ${isSuper ? '统一管理三个系统 · 开通主管理员（经营主体）并监控全系统运行'
          : MODE_NAME[m] + '系统 · 主管理员 / 员工账号登录'}</p>
        <div class="mb-3"><label class="form-label">用户名</label>
          <input id="lgUser" class="form-control" value="${defUser}" placeholder="请输入用户名"></div>
        <div class="mb-3"><label class="form-label">密码</label>
          <input id="lgPwd" type="password" class="form-control" value="${defPwd}" placeholder="请输入密码"
                 onkeydown="if(event.key==='Enter')doLogin()"></div>
        <button class="btn btn-primary w-100" onclick="doLogin()">登 录</button>
        ${cfg.login_selector === 'hide' ? ''
          : '<div class="text-center mt-3"><a class="small" href="#login">← 返回选择登录入口</a></div>'}
      </div>
    </div>
  </div>`;
}

async function doLogin(){
  const username = $('#lgUser').value.trim();
  const password = $('#lgPwd').value;
  try {
    const body = { username, password, mode: LOGIN_MODE };
    const u = await api('/api/login', 'POST', body);
    ME = u; /* 含 role_name / level / mode / pages */
    sessionStorage.setItem('house_token', u.token);
    /* 登录后立即加载本主体设置（默认币种/汇率/单价），避免用前端初始默认值 */
    try {
      const st = await api('/api/settings');
      DB.data.settings = {
        mode: u.mode || 'rental',
        currency: st.currency || 'USD',
        rate: Number(st.rate) || 7.2,
        prices: !!st.prices,
        net_price_per_mb: (st.net_price_per_mb !== undefined && st.net_price_per_mb !== null)
          ? Number(st.net_price_per_mb) : 1,
        water_price: (st.water_price !== undefined && st.water_price !== null)
          ? Number(st.water_price) : 4.5,
        elec_price: (st.elec_price !== undefined && st.elec_price !== null)
          ? Number(st.elec_price) : 1,
        remind_enable: Number(st.remind_enable === undefined ? 1 : st.remind_enable),
        remind_days: Number(st.remind_days === undefined ? 3 : st.remind_days),
        item_lib: Array.isArray(st.item_lib) ? st.item_lib : []
      };
    } catch(e){ console.error('settings 加载失败', e); }
    history.replaceState(null, '', '#' + ((u.level === 'staff' || u.level === 'manager') ? 'home' : firstAllowedPage(u.mode) || DEFAULT_PAGE[u.mode]));
    renderApp();
  } catch(e){ alert(e.message); }
}

async function doLogout(){
  if (!confirm('确定退出登录？')) return;
  try { await api('/api/logout', 'POST'); } catch(e){}
  ME = null;
  sessionStorage.removeItem('house_token');
  history.replaceState(null, '', '#login');
  showLogin();
}

const NAV = {
  rental: [
    ['dashboard','speedometer2','仪表盘'],
    ['rooms','door-open','房源管理'],
    ['tenants','people','租客管理'],
    ['contracts','file-earmark-text','合同管理'],
    ['meters','lightning-charge','水电抄表'],
    ['network','ethernet','网络管理'],
    ['bills','cash-coin','账单收费'],
    ['repairs','tools','报修管理'],
    ['buildings','building','楼栋管理'],
    ['users','person-gear','员工管理', 'admin'],
    ['roles','shield-lock','角色管理', 'admin'],
    ['settings','gear','系统设置', 'admin']
  ],
  hotel: [
    ['dashboard','speedometer2','仪表盘'],
    ['roommap','grid-3x3-gap','房态图'],
    ['orders','journal-check','订单管理'],
    ['rooms','door-open','房间管理'],
    ['tenants','people','房客管理'],
    ['bills','cash-coin','账单收费'],
    ['repairs','tools','报修管理'],
    ['buildings','building','楼栋管理'],
    ['users','person-gear','员工管理', 'admin'],
    ['roles','shield-lock','角色管理', 'admin'],
    ['settings','gear','系统设置', 'admin']
  ],
  property: [
    ['dashboard','speedometer2','仪表盘'],
    ['buildings','building','楼栋管理'],
    ['properties','houses','房产管理'],
    ['owners','building','企业管理'],
    ['dorm','house-heart','宿舍管理'],
    ['meters','lightning-charge','水电抄表'],
    ['network','ethernet','网络管理'],
    ['bills','cash-coin','账单收费'],
    ['complaints','chat-square-text','投诉建议'],
    ['repairs','tools','报修管理'],
    ['users','person-gear','员工管理', 'admin'],
    ['roles','shield-lock','角色管理', 'admin'],
    ['settings','gear','系统设置', 'admin']
  ]
};

/* 当前数据系统：会话系统（管理员/员工固定为所属系统） */
const curMode = () => (ME && ME.mode) || (DB.data.settings ? DB.data.settings.mode : 'rental');

/* 计费房间：物业=已绑定企业；租房=已出租；酒店=全部（无水电网，不使用） */
function billableRooms(rooms){
  const mode = curMode();
  if (mode === 'property') return rooms.filter(r => r.owner_id);
  if (mode === 'rental') return rooms.filter(r => r.status === 'rented');
  return rooms;
}
/* 计费对象称谓：物业=企业，租房=租客 */
function personLabel(){ return curMode() === 'property' ? '企业' : '租客'; }
function roomPerson(r){ return curMode() === 'property' ? (r.owner_name || '') : (r.tenant_name || r.owner_name || ''); }
function roomPersonPhone(r){ return r.owner_phone || ''; }

function pageAllowed(p){
  if (ME.level === 'super' || ME.level === 'admin') return true;
  return (ME.pages || []).includes(p);
}
/* 操作权限：主管理员全有；员工/企业管理员按角色 ops 判定 */
const canOp = (op) => ME.level === 'admin' || (ME.ops || []).includes(op);

/* 操作权限功能点清单（动作级，按功能模块分组；租房/酒店/物业各自独立） */
const OP_DEFS = {
  rental: [
    { g:'楼栋管理', items:[['building_add','新增'],['building_edit','编辑'],['building_delete','删除']] },
    { g:'房源管理', items:[['room_add','新增'],['room_edit','编辑/状态'],['room_delete','删除']] },
    { g:'租客管理', items:[['tenant_add','新增'],['tenant_edit','编辑'],['tenant_delete','删除']] },
    { g:'合同管理', items:[['contract_add','签订'],['contract_edit','编辑'],['contract_delete','终止/删除']] },
    { g:'水电抄表', items:[['meter_add','录入'],['meter_edit','编辑'],['meter_delete','删除']] },
    { g:'网络管理', items:[['netline_add','新增线路'],['netline_edit','编辑线路'],['netline_bandwidth','加兆/减兆'],['netline_status','停用/启用']] },
    { g:'账单收费', items:[['bill_add','手动添加'],['bill_generate','生成'],['bill_delete','删除'],['bill_pay','收款'],['bill_print','打印账单'],['bill_remind','账单提醒']] },
    { g:'报修管理', items:[['repair_add','登记'],['repair_handle','处理'],['repair_delete','删除']] },
    { g:'商品库', items:[['itemlib_use','使用商品库（联想/批量添加）']] }
  ],
  hotel: [
    { g:'楼栋管理', items:[['building_add','新增'],['building_edit','编辑'],['building_delete','删除']] },
    { g:'房间管理', items:[['room_add','新增'],['room_edit','编辑/状态'],['room_delete','删除']] },
    { g:'订单管理', items:[['order_add','预订/开房'],['order_edit','编辑'],['order_status','入住/退房/取消'],['order_delete','删除']] },
    { g:'房客管理', items:[['tenant_add','新增'],['tenant_edit','编辑'],['tenant_delete','删除']] },
    { g:'账单收费', items:[['bill_add','手动添加'],['bill_generate','生成'],['bill_delete','删除'],['bill_pay','收款'],['bill_print','打印账单'],['bill_remind','账单提醒']] },
    { g:'报修管理', items:[['repair_add','登记'],['repair_handle','处理'],['repair_delete','删除']] }
  ],
  property: [
    { g:'楼栋管理', items:[['building_add','新增'],['building_edit','编辑'],['building_delete','删除']] },
    { g:'房产管理', items:[['room_add','新增'],['room_edit','编辑/状态'],['room_delete','删除']] },
    { g:'企业管理', items:[['tenant_add','新增'],['tenant_edit','编辑/设管理员'],['tenant_delete','删除']] },
    { g:'企业员工', items:[['orgemp_add','新增'],['orgemp_edit','编辑'],['orgemp_delete','删除']] },
    { g:'宿舍管理', items:[['dorm_assign','分配/调宿/退宿']] },
    { g:'水电抄表', items:[['meter_add','录入'],['meter_edit','编辑'],['meter_delete','删除']] },
    { g:'网络管理', items:[['netline_add','新增线路'],['netline_edit','编辑线路'],['netline_bandwidth','加兆/减兆'],['netline_status','停用/启用']] },
    { g:'账单收费', items:[['bill_add','手动添加'],['bill_generate','生成'],['bill_delete','删除'],['bill_pay','收款'],['bill_print','打印账单'],['bill_remind','账单提醒']] },
    { g:'报修管理', items:[['repair_add','登记'],['repair_handle','处理'],['repair_delete','删除']] },
    { g:'投诉建议', items:[['complaint_add','登记'],['complaint_handle','处理'],['complaint_delete','删除']] },
    { g:'商品库', items:[['itemlib_use','使用商品库（联想/批量添加）']] }
  ]
};
const opLabel = (op) => {
  const groups = OP_DEFS[curMode()] || [];
  for (const g of groups){
    const it = g.items.find(x => x[0] === op);
    if (it) return g.g + '：' + it[1];
  }
  return op;
};
/* 操作权限按模块分组显示：["楼栋管理：新增 删除 编辑", "水电抄表：录入"] */
const groupOps = (ops) => {
  const m = {};
  (ops || []).forEach(op => {
    const l = opLabel(op);
    const i = l.indexOf('：');
    const mod = i > 0 ? l.slice(0, i) : l;
    const act = i > 0 ? l.slice(i + 1) : l;
    (m[mod] = m[mod] || []).push(act);
  });
  return Object.keys(m).map(mod => `${mod}：${m[mod].join(' ')}`);
};
/* 任一操作权限即显示对应操作列（管理员全 true） */
const canAnyOp = (...ops) => ops.some(op => canOp(op));

/* 按角色取导航：超管=控制台（系统监控 / 开通主管理员）；主管理员=所属系统全部管理页；员工=工作台+授权页；企业管理员=本企业数据页（只读） */
function curNav(){
  if (!ME) return [];
  if (ME.level === 'super') return [
    ['monitor','activity','系统监控'],
    ['fee','cash-stack','系统使用费'],
    ['orgs','person-gear','主管理员管理'],
    ['appcfg','gear','系统设置']
  ];
  if (ME.level === 'staff' || ME.level === 'manager') return [['home','house','工作台'],
    ...NAV[curMode()].filter(n => pageAllowed(n[0]) && n[3] === undefined)];
  if (ME.level === 'company_admin') return NAV.property.filter(n =>
    pageAllowed(n[0]) && n[3] === undefined);
  return NAV[curMode()].filter(n => pageAllowed(n[0]) && (n[3] === undefined || n[3] === 'admin'));
}
function firstAllowedPage(mode){
  const nav = curNav();
  return (nav.find(n => pageAllowed(n[0])) || [null])[0]
      || (pageAllowed(DEFAULT_PAGE[mode]) ? DEFAULT_PAGE[mode] : null);
}

function renderApp(){
  const mode = curMode();
  const cur = getCurrency();
  const isSuper = ME.level === 'super';
  /* 员工/管理员（manager）统一走工作台分支，界面与权限配置一致 */
  const isStaff = ME.level === 'staff' || ME.level === 'manager';
  /* 标签页标题只显示当前系统 */
  document.title = '房屋管理系统 · ' + (isSuper ? '管理控制台' : isStaff ? MODE_NAME[mode] + '工作台' : MODE_NAME[mode] + '系统');
  const nav = curNav();
  $('#root').innerHTML = `
  <div class="d-flex">
    <aside class="sidebar p-3">
      <h5 class="text-white mb-3"><i class="bi bi-${isSuper ? 'shield-lock' : isStaff ? 'person-badge' : 'buildings'}"></i>
        ${isSuper ? '管理控制台' : isStaff ? '工作台' : MODE_NAME[mode] + '系统'}</h5>
      ${isSuper ? `
      <div class="mode-lock mb-1 text-white-50 small">
        <i class="bi bi-globe2"></i> 开通各系统主管理员（经营主体），并监控全系统运行
      </div>` : ''}
      ${(!isSuper && !isStaff) ? `
      <div class="mode-lock mb-1 text-white-50 small">
        <i class="bi bi-building"></i> ${esc(ME.level === 'company_admin' ? (ME.company_name || '') : (ME.org_name || ''))}
      </div>
      <div class="mode-lock mb-1 text-white-50 small">
        <i class="bi bi-lock"></i> ${esc(ME.level === 'company_admin' ? '企业管理员' : (ME.role_name || ME.role))}
      </div>` : ''}
      ${isStaff ? `
      <div class="mode-lock mb-1 text-white-50 small">
        <i class="bi bi-lock"></i> ${MODE_NAME[mode]} · 员工工作台
      </div>` : ''}
      ${ME.level === 'admin' ? `
      <div class="cur-row mb-3">
        <select onchange="switchCurrency(this.value)">
          <option value="CNY" ${cur === 'CNY' ? 'selected' : ''}>¥ 人民币</option>
          <option value="USD" ${cur === 'USD' ? 'selected' : ''}>$ 美元</option>
        </select>
      </div>` : ''}
      <nav class="nav flex-column" id="nav">
        ${nav.map(n => `<a class="nav-link" data-page="${n[0]}" onclick="go('${n[0]}')">
          <i class="bi bi-${n[1]}"></i> ${n[2]}</a>`).join('')}
      </nav>
      <div class="mt-auto pt-3 small text-white-50">
        <div class="mb-2"><i class="bi bi-person-circle"></i> ${esc(ME.name || ME.real_name || ME.username)}
          <span class="badge bg-secondary">${esc(ME.level === 'company_admin' ? '企业管理员' : (ME.role_name || ME.role))}</span></div>
        <button class="btn btn-sm btn-outline-light w-100" onclick="doLogout()">退出登录</button>
      </div>
    </aside>
    <main class="flex-grow-1 p-4">
      <h4 id="pageTitle" class="mb-3"></h4>
      <div id="page"></div>
    </main>
  </div>`;
  go(location.hash.slice(1) || firstAllowedPage(mode) || DEFAULT_PAGE[mode]);
  checkBillReminder();
  if (ME.level === 'super') checkSuperFeeNotice();
  else checkFeeNotice();
  startFeePolling();
}

/* 系统使用费提醒（主管理员可见）：超期/临期/已关闭时顶部横幅提醒；
 * 登录时检查一次，并在登录期间每 5 分钟轮询 /me 刷新状态，到期状态出现或变化时再次提醒 */
let _feeRemindShown = false;
let _feeNotifiedKey = '';
function checkFeeNotice(){
  try {
    if (!ME || ME.level !== 'admin' || !ME.fee_notice) return;
    const n = ME.fee_notice;
    const key = n.status + ':' + n.days + ':' + n.due;
    if (key === _feeNotifiedKey) return; /* 同一到期状态只提醒一次 */
    _feeNotifiedKey = key;
    _feeRemindShown = true;
    const txt = n.status === 'closed'
      ? '<b>系统使用费</b>：本系统已被超管关闭，请联系管理员处理'
      : n.status === 'overdue'
        ? `<b>系统使用费</b>：已超期 <b class="text-danger">${n.days}</b> 天（到期日 ${n.due}），请尽快续费，否则系统将停用`
        : `<b>系统使用费</b>：将于 <b>${n.days}</b> 天后到期（${n.due}），请及时续费`;
    const bar = document.createElement('div');
    bar.className = 'fee-remind-bar alert alert-danger d-flex align-items-center rounded-0 mb-0';
    bar.style.cssText = 'position:sticky;top:0;z-index:1050';
    bar.innerHTML = `<div class="ms-2"><i class="bi bi-cash-stack"></i> ${txt}</div>
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-sm btn-outline-danger" onclick="this.closest('.fee-remind-bar').remove()">知道了</button>
      </div>`;
    const main = document.querySelector('main');
    if (main) main.prepend(bar);
    else document.body.prepend(bar);
  } catch(e){ /* 提醒失败不影响使用 */ }
}
let _feePollingStarted = false;
function startFeePolling(){
  if (!ME || _feePollingStarted) return;
  _feePollingStarted = true;
  setInterval(async () => {
    try {
      if (ME.level === 'admin'){
        const me = await api('/api/me');
        if (me && me.fee_notice){ ME.fee_notice = me.fee_notice; checkFeeNotice(); }
      } else if (ME.level === 'super'){
        checkSuperFeeNotice();
      }
    } catch(e){ /* 网络或会话异常时跳过本轮 */ }
  }, 5 * 60 * 1000);
}
/* 超管到期提醒：聚合所有经营主体，有超期/临期/已关闭时顶部横幅提醒 */
let _superFeeKey = '';
async function checkSuperFeeNotice(){
  try {
    if (!ME || ME.level !== 'super') return;
    const [orgs, cfg] = await Promise.all([api('/api/fee-orgs'), api('/api/fee-config')]);
    const t = today();
    const dDue = o => Math.round((new Date(o.fee_due + 'T00:00:00') - new Date(t + 'T00:00:00')) / 86400000); /* 到期-今天：负=超期，0~remind 天内=临期 */
    const ovd = orgs.filter(o => o.fee_status !== 'closed' && o.fee_due && dDue(o) < 0);
    const soon = orgs.filter(o => o.fee_status !== 'closed' && o.fee_due && dDue(o) >= 0 && dDue(o) <= cfg.remind_days);
    const closed = orgs.filter(o => o.fee_status === 'closed');
    const key = JSON.stringify([ovd.map(o=>o.id+':'+o.fee_due), soon.map(o=>o.id+':'+o.fee_due), closed.map(o=>o.id)]);
    if (key === _superFeeKey) return;
    if (!ovd.length && !soon.length && !closed.length){ _superFeeKey = key; return; }
    _superFeeKey = key;
    const parts = [];
    if (ovd.length) parts.push(`<span class="text-danger fw-bold">${ovd.length}</span> 个经营主体已超期`);
    if (soon.length) parts.push(`${soon.length} 个即将到期`);
    if (closed.length) parts.push(`${closed.length} 个已关闭`);
    const bar = document.createElement('div');
    bar.className = 'fee-remind-bar alert alert-danger d-flex align-items-center rounded-0 mb-0';
    bar.style.cssText = 'position:sticky;top:0;z-index:1050';
    bar.innerHTML = `<div class="ms-2"><i class="bi bi-cash-stack"></i> <b>系统使用费</b>：${parts.join('、')}</div>
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-sm btn-outline-danger" onclick="go('#fee')">去查看</button>
        <button class="btn btn-sm btn-outline-secondary" onclick="this.closest('.fee-remind-bar').remove()">知道了</button>
      </div>`;
    const main = document.querySelector('main');
    if (main) main.prepend(bar);
    else document.body.prepend(bar);
  } catch(e){ /* 提醒失败不影响使用 */ }
}

/* 账单到期提醒横幅：主管理员开启后，存在符合条件的未收账单即提醒；
   可见性受角色权限「账单提醒」控制（主管理员默认可见，员工/企业管理员需角色勾选）；
   页面生命周期内（不刷新）仅弹一次，点「知道了」只关闭当前横幅 */
let _remindShown = false;
async function checkBillReminder(){
  try {
    if (_remindShown || !ME || ME.level === 'super') return;
    if (typeof canOp === 'function' && !canOp('bill_remind')) return;
    const r = await api('/api/bill-reminders');
    if (!r || !r.enabled || !r.total) return;
    _remindShown = true;
    const bar = document.createElement('div');
    bar.className = 'bill-remind-bar alert alert-warning d-flex align-items-center rounded-0 mb-0';
    bar.style.cssText = 'position:sticky;top:0;z-index:1050';
    const sumLabel = ME.level === 'company_admin' ? '未付合计' : '未收合计';
    bar.innerHTML = `<div class="ms-2"><i class="bi bi-bell-fill"></i> <b>账单提醒</b>：有 ${r.total} 张账单待收
      ${r.overdue ? `<span class="badge bg-danger ms-1">已逾期 ${r.overdue}</span>` : ''}
      ${r.due_soon ? `<span class="badge bg-warning text-dark ms-1">临期 ${r.due_soon}</span>` : ''}
      · ${sumLabel} <b>${money(r.amount)}</b></div>
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-sm btn-outline-primary" onclick="go('bills')">去查看</button>
        <button class="btn btn-sm btn-outline-secondary" onclick="this.closest('.bill-remind-bar').remove()">知道了</button>
      </div>`;
    const main = document.querySelector('main');
    if (main) main.prepend(bar);
    else document.body.prepend(bar);
  } catch(e){ /* 提醒失败不影响使用 */ }
}

async function switchCurrency(c, silent){
  if (!DB.data.settings) return;
  if (DB.data.settings.currency === c) return;
  DB.data.settings.currency = c;
  /* 登录页（无 token）仅本地切换，登录后以后端该主体设置为准 */
  const token = sessionStorage.getItem('house_token');
  if (token){ try { await api('/api/settings', 'PUT', { currency: c }); } catch(e){ console.error(e); } }
  if (silent) return;
  renderApp();
}

/* 系统设置：主管理员配置本经营主体（酒店仅汇率/币种；租房、物业另含网费/水电单价） */
function editSettings(){
  if (ME.level !== 'admin'){ alert('仅主管理员可修改系统设置'); return; }
  const mode = curMode();
  const withPrices = mode !== 'hotel';
  const s = DB.data.settings || {};
  const fields = [
    { name:'currency', label:'记账/显示币种', type:'select', required:true, options:[
      { value:'USD', label:'$ 美元' }, { value:'CNY', label:'¥ 人民币' } ] },
    { name:'rate', label:'1 美元 = ? 人民币', type:'number', required:true, step:'0.0001',
      hint:'系统内部统一以人民币存储金额；切换到美元后按此汇率换算显示。' }
  ];
  if (withPrices){
    fields.push(
      { name:'net_price_per_mb', label:'网费单价默认（/兆/月）', type:'number', step:'0.01', money:true,
        hint:'新增房间时「每兆月租」自动填入该值；已建房间单价不受影响。' },
      { name:'water_price', label:'水价默认（/吨）', type:'number', step:'0.01', money:true,
        hint:'新增房间时「水费单价」自动填入该值；已建房间单价不受影响。' },
      { name:'elec_price', label:'电价默认（/度）', type:'number', step:'0.01', money:true,
        hint:'新增房间时「电费单价」自动填入该值；已建房间单价不受影响。' }
    );
  }
  fields.push(
    { name:'remind_enable', label:'账单到期提醒', type:'select', required:true, options:[
      { value:1, label:'开启（登录后提醒未收款账单）' }, { value:0, label:'关闭' }] },
    { name:'remind_days', label:'提前提醒天数', type:'number', required:true, step:'1', min:0,
      hint:'应缴日期距今天数 ≤ 该值即提醒；填 0 表示仅提醒已逾期账单。' }
  );
  openForm('系统设置 · ' + MODE_NAME[mode], fields,
    {
      currency: s.currency || 'USD', rate: getRate(),
      net_price_per_mb: s.net_price_per_mb, water_price: s.water_price, elec_price: s.elec_price,
      remind_enable: Number(s.remind_enable === undefined ? 1 : s.remind_enable),
      remind_days: Number(s.remind_days === undefined ? 3 : s.remind_days)
    },
    async (d, modal) => {
      const payload = { currency: d.currency, rate: Number(d.rate), remind_enable: Number(d.remind_enable), remind_days: Number(d.remind_days) };
      if (withPrices){
        payload.net_price_per_mb = Number(d.net_price_per_mb) || 0;
        payload.water_price = Number(d.water_price) || 0;
        payload.elec_price = Number(d.elec_price) || 0;
      }
      const saved = await api('/api/settings', 'PUT', payload);
      DB.data.settings = {
        mode, currency: saved.currency, rate: Number(saved.rate),
        net_price_per_mb: saved.net_price_per_mb, water_price: saved.water_price,
        elec_price: saved.elec_price, prices: saved.prices,
        remind_enable: Number(saved.remind_enable === undefined ? 1 : saved.remind_enable),
        remind_days: Number(saved.remind_days === undefined ? 3 : saved.remind_days),
        item_lib: (DB.data.settings && DB.data.settings.item_lib) || []
      };
      modal.hide();
      renderApp();
    });
}

async function renderSettings(){
  const mode = curMode();
  $('#page').innerHTML = `
  <div class="card"><div class="card-body" style="max-width:720px">
    <h5><i class="bi bi-gear text-primary"></i> 系统设置</h5>
    <p class="text-muted mb-2">配置本经营主体（<b>${esc(ME.org_name || '')}</b>）的记账币种与汇率${mode === 'hotel' ? '' : '、网费及水电单价'}。</p>
    <ul class="small text-muted ps-3 mb-3">
      <li>金额内部以人民币存储，按汇率换算为美元显示；各经营主体的汇率与单价相互独立。</li>
      ${mode === 'hotel' ? '<li>酒店仅涉及房费，无网费/水电单价设置。</li>'
        : '<li>网费/水电单价作为新增房间的默认值，已建房间单价不受影响。</li>'}
      <li>账单到期提醒：${Number(DB.data.settings.remind_enable === undefined ? 1 : DB.data.settings.remind_enable) ? '已开启，提前 ' + Number(DB.data.settings.remind_days === undefined ? 3 : DB.data.settings.remind_days) + ' 天提醒未收款账单' : '已关闭'}</li>
    </ul>
    <button class="btn btn-primary" onclick="editSettings()"><i class="bi bi-sliders"></i> 打开设置</button>
  </div></div>
  <div class="card mt-3"><div class="card-body" style="max-width:720px">
    <div class="d-flex justify-content-between align-items-center mb-1">
      <h6 class="mb-0"><i class="bi bi-journal-text text-primary"></i> 常用商品库</h6>
      <button class="btn btn-sm btn-outline-secondary" onclick="libAddRow()"><i class="bi bi-plus-lg"></i> 添加</button>
    </div>
    <p class="small text-muted mb-2">明细录入时输入商品名可联想带出型号与单价，也可在明细弹窗点「从商品库添加」批量生成；数据仅本经营主体可见。</p>
    <div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-2">
      <thead class="table-light text-center"><tr><th style="width:13%">类别</th><th style="width:33%">商品</th><th style="width:28%">型号</th><th style="width:16%">单价(${currencySymbol()})</th><th style="width:48px"></th></tr></thead>
      <tbody id="lib_tb"></tbody>
    </table></div>
    <button class="btn btn-sm btn-primary" onclick="saveItemLib()">保存商品库</button>
    <span id="lib_save_msg" class="small text-success ms-2"></span>
  </div></div>`;
  libRender();
}
/* ===== 常用商品库维护（系统设置页，仅主管理员可见） ===== */
let _libDraft = [];
function libRender(){
  _libDraft = (DB.data.settings.item_lib || []).map(it => ({
    cat: it.cat === 'util' ? 'util' : 'net',
    name: it.name, model: it.model || '', price: toDisplayMoney(it.price)
  }));
  libPaint();
}
function libPaint(){
  const tb = document.getElementById('lib_tb');
  if (!tb) return;
  if (!_libDraft.length){
    tb.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">暂无商品，点击右上角「添加」录入</td></tr>';
    return;
  }
  tb.innerHTML = _libDraft.map((it, i) => `<tr>
    <td style="min-width:90px"><select class="form-select form-select-sm" style="min-width:86px" data-lib="cat" data-i="${i}">
      <option value="net" ${it.cat === 'net' ? 'selected' : ''}>网络</option>
      <option value="util" ${it.cat === 'util' ? 'selected' : ''}>水电</option>
    </select></td>
    <td><input class="form-control form-control-sm" data-lib="name" data-i="${i}" value="${esc(it.name)}"></td>
    <td><input class="form-control form-control-sm" data-lib="model" data-i="${i}" value="${esc(it.model)}"></td>
    <td><input class="form-control form-control-sm" data-lib="price" data-i="${i}" type="number" min="0" step="0.01" value="${esc(it.price)}"></td>
    <td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" title="删除" onclick="libDel(${i})">×</button></td>
  </tr>`).join('');
}
function libAddRow(){ _libDraft.push({ cat:'net', name:'', model:'', price:'' }); libPaint(); }
function libDel(i){ _libDraft.splice(i, 1); libPaint(); }
async function saveItemLib(){
  const tb = document.getElementById('lib_tb');
  if (!tb) return;
  const arr = [];
  for (const tr of tb.rows){
    const name = (tr.querySelector('[data-lib="name"]').value || '').trim();
    if (!name) continue;
    const model = (tr.querySelector('[data-lib="model"]').value || '').trim();
    const price = Number(tr.querySelector('[data-lib="price"]').value);
    if (!Number.isFinite(price) || price < 0){ alert('商品「' + name + '」单价不合法'); return; }
    const cat = tr.querySelector('[data-lib="cat"]').value === 'util' ? 'util' : 'net';
    arr.push({ cat, name, model, price: Math.round(fromDisplayMoney(price) * 100) / 100 });
  }
  try {
    const saved = await api('/api/settings', 'PUT', { item_lib: arr });
    DB.data.settings.item_lib = saved.item_lib || [];
    _libDraft = (saved.item_lib || []).map(it => ({ cat: it.cat === 'util' ? 'util' : 'net', name: it.name, model: it.model || '', price: toDisplayMoney(it.price) }));
    libPaint();
    const msg = document.getElementById('lib_save_msg');
    if (msg){ msg.textContent = '已保存 ' + saved.item_lib.length + ' 条'; setTimeout(() => msg.textContent = '', 2500); }
  } catch(e){ alert(e.message); }
}

async function go(page){
  const mode = curMode();
  const nav = curNav();
  /* 企业管理员未配置任何页面权限：提示联系主管理员 */
  if (ME.level === 'company_admin' && !nav.length){
    history.replaceState(null, '', '#');
    $('#pageTitle').textContent = '权限未配置';
    $('#page').innerHTML = `<div class="card"><div class="card-body text-center py-5">
      <i class="bi bi-shield-lock" style="font-size:3rem;color:#adb5bd"></i>
      <p class="mt-3 mb-1 fw-bold">企业管理员权限未配置</p>
      <p class="text-muted small mb-0">请联系物业主管理员：在「角色管理」配置页面权限并为你分配角色后重新登录。</p>
    </div></div>`;
    return;
  }
  /* 企业员工：管理页内 Tab（物业，参与权限配置；员工无权限时会被 pageAllowed 拦在导航外） */
  if (page === 'orgemp'){ ORG_TAB = 'orgemp'; page = 'owners'; }
  else if (page === 'owners'){ ORG_TAB = 'owners'; }
  let item = nav.find(n => n[0] === page);
  if (!item){
    page = firstAllowedPage(mode) || DEFAULT_PAGE[mode];
    item = nav.find(n => n[0] === page);
  }
  if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);
  document.querySelectorAll('#nav .nav-link').forEach(a =>
    a.classList.toggle('active', a.dataset.page === page));
  $('#pageTitle').textContent = item[2];
  $('#page').innerHTML = '<div class="text-muted p-4"><span class="spinner-border spinner-border-sm"></span> 加载中…</div>';
  try { await PAGES[page].render(); }
  catch(e){ console.error(e); $('#page').innerHTML = `<div class="alert alert-danger">加载失败：${esc(e.message)}</div>`; }
}

