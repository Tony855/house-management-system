'use strict';
/* ==================================================================
 * 19. 楼栋管理
 * ================================================================== */
async function renderBuildings(){
  const list = await api('/api/buildings');
  const mode = curMode();
  const unit = mode === 'property' ? '户数' : '房间数';

  $('#page').innerHTML = `
  <div class="mb-3">${canOp('building_add') ? `<button class="btn btn-primary btn-sm" onclick="editBuilding()">+ 新增楼栋</button>` : ''}</div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>楼栋名称</th><th>地址</th><th>${unit}</th><th>备注</th>${canAnyOp('building_add','building_edit','building_delete') ? '<th width="160">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(b => `<tr>
      <td><b>${esc(b.name)}</b></td><td>${esc(b.address || '-')}</td>
      <td><span class="badge bg-info">${b.room_count}</span></td>
      <td>${esc(b.remark || '-')}</td>
      <td>${canAnyOp('building_add','building_edit','building_delete') ? `
        ${canOp('building_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editBuilding(${b.id})">编辑</button>` : ''}
        ${canOp('building_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delBuilding(${b.id})">删除</button>` : ''}` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

async function editBuilding(id){
  let data = {};
  if (id){ const list = await api('/api/buildings'); data = list.find(x => x.id === id) || {}; }
  openForm(id ? '编辑楼栋' : '新增楼栋', [
    { name:'name', label:'楼栋名称', required:true, placeholder:'如：A栋' },
    { name:'address', label:'地址' },
    { name:'remark', label:'备注', type:'textarea' }
  ], data, async (d, modal) => {
    await api(id ? '/api/buildings/' + id : '/api/buildings', id ? 'PUT' : 'POST', d);
    modal.hide(); renderBuildings();
  });
}

async function delBuilding(id){
  if (!confirm('确定删除该楼栋？')) return;
  try { await api('/api/buildings/' + id, 'DELETE'); renderBuildings(); }
  catch(e){ alert(e.message); }
}

/* ==================================================================
 * 20. 用户管理（超管：管理员管理；管理员：本系统员工管理）
 * ================================================================== */
async function renderUsers(){
  const list = await api('/api/users');
  /* 主管理员仅管理本经营主体的员工 */
  const rows = list.filter(u => u.level === 'staff' || u.level === 'manager');
  const permCell = u => {
    const rp = u.role_pages || [], ro = groupOps(u.role_ops || []);
    const pages = rp.length
      ? `<div class="d-flex flex-wrap gap-1">${rp.map(p => `<span class="badge bg-light text-dark border">${esc(pageName(p))}</span>`).join('')}</div>`
      : '<span class="text-muted small">无</span>';
    const ops = ro.length
      ? `<div class="d-flex flex-wrap gap-1 mt-1">${ro.map(g => `<span class="badge bg-light text-primary border">${esc(g)}</span>`).join('')}</div>`
      : '';
    return pages + ops;
  };
  $('#page').innerHTML = `
  <div class="mb-3 d-flex gap-2">
    <button class="btn btn-sm btn-primary" onclick="editUser()">+ 新增员工</button>
    <div class="text-muted small align-self-center">
      管理本系统（${esc(ME.org_name || '')}）员工账号；员工权限来自其所属角色
    </div>
  </div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>用户名</th><th>姓名</th><th>角色</th>
      <th>角色权限</th><th>创建时间</th><th width="170">操作</th>
    </tr></thead>
    <tbody>${rows.map(u => `<tr>
      <td><b>${esc(u.username)}</b></td><td>${esc(u.real_name || '-')}</td>
      <td><span class="badge bg-secondary">${esc(u.role_name || u.role)}</span></td>
      <td>${permCell(u)}</td>
      <td><small>${esc(u.created_at || '-')}</small></td>
      <td>
        <button class="btn btn-sm btn-outline-primary" onclick="editUser(${u.id})">编辑</button>
        ${u.id !== ME.id
          ? `<button class="btn btn-sm btn-outline-danger" onclick="delUser(${u.id})">删除</button>` : ''}
      </td></tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted py-4">暂无员工</td></tr>'}
    </tbody></table></div></div>`;
}

function pageName(p){
  if (p === 'orgemp') return '企业员工';
  const all = [].concat(NAV.rental, NAV.hotel, NAV.property);
  const hit = all.find(n => n[0] === p);
  return hit ? hit[2] : p;
}

/* 页面权限清单：系统导航 + 物业「企业员工」（管理页内 Tab，不占独立导航项） */
function pageOpts(mode){
  const list = (NAV[mode] || []).filter(n => !n[3]).map(n => ({ value:n[0], label:n[2] }));
  if (mode === 'property') list.push({ value:'orgemp', label:'企业员工' });
  return list;
}

async function editUser(id){
  let data = { role:'staff' };
  if (id){ const list = await api('/api/users'); data = list.find(x => x.id === id) || data; }
  const roles = await api('/api/roles');
  /* 主管理员只能分配员工级/管理员级角色（内置 staff + 本主体自建角色） */
  const roleOpts = roles.filter(r => r.level === 'staff' || r.level === 'manager');
  if (!roleOpts.length){ alert('暂无可用角色'); return; }
  if (!roleOpts.some(r => r.code === data.role)) data.role = roleOpts[0].code;
  const fields = [
    { name:'username', label:'用户名', required:true },
    { name:'real_name', label:'姓名' },
    { name:'password', label: id ? '密码（留空不修改）' : '密码', type:'password', required: !id },
    { name:'role', label:'角色', type:'select', required:true,
      options: roleOpts.map(r => ({ value:r.code, label:r.name })) }
  ];
  openForm(id ? '编辑员工' : '新增员工', fields, data, async (d, modal) => {
    d.mode = undefined;
    await api(id ? '/api/users/' + id : '/api/users', id ? 'PUT' : 'POST', d);
    modal.hide(); renderUsers();
  }, (el) => {
    /* 角色切换时动态显示该角色已配置的页面与操作权限 */
    const sel = el.querySelector('select[name=role]');
    if (!sel) return;
    const box = sel.closest('.mb-3');
    const hint = document.createElement('div');
    hint.className = 'form-text';
    box.appendChild(hint);
    const render = () => {
      const r = roleOpts.find(x => x.code === sel.value);
      if (!r) return;
      const pages = (r.pages || []).map(p => pageName(p)).join('、') || '无';
      const ops = (r.ops || []).map(opLabel).join('；') || '无';
      hint.textContent = '该角色【' + r.name + '】自动授予 —— 页面：' + pages + '；操作：' + ops;
    };
    sel.addEventListener('change', render);
    render();
  });
}

async function delUser(id){
  if (!confirm('确定删除该用户？')) return;
  try { await api('/api/users/' + id, 'DELETE'); renderUsers(); }
  catch(e){ alert(e.message); }
}

/* 角色管理（主管理员在本经营主体内自建员工角色；内置角色只读） */
async function renderRoles(){
  const roles = await api('/api/roles');
  const lvlBadge = l => l === 'admin' ? '<span class="badge bg-warning text-dark">主管理员</span>'
    : l === 'manager' ? '<span class="badge bg-info text-dark">管理员</span>'
    : '<span class="badge bg-secondary">员工</span>';
  const permTxt = r => (r.pages && r.pages.length)
    ? `<div class="d-flex flex-wrap gap-1">${r.pages.map(p => `<span class="badge bg-light text-dark border">${esc(pageName(p))}</span>`).join('')}</div>`
    : (r.is_system ? '<span class="text-muted small">—</span>' : '<span class="text-muted small">未配置</span>');
  const opsTxt = r => (r.ops && r.ops.length)
    ? `<div class="d-flex flex-wrap gap-1 mt-1">${groupOps(r.ops).map(l => `<span class="badge bg-light text-primary border">${esc(l)}</span>`).join('')}</div>`
    : '<span class="text-muted small">—</span>';
  $('#page').innerHTML = `
  <div class="mb-3 d-flex gap-2">
    <button class="btn btn-sm btn-primary" onclick="editRole()">+ 新增角色</button>
    <div class="text-muted small align-self-center">
      为本系统（${esc(ME.org_name || '')}）自定义角色并配置权限，再到「员工管理」分配
    </div>
  </div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>角色名称</th><th>编码</th><th>层级</th>
      <th>角色权限</th><th>类型</th><th width="150">操作</th>
    </tr></thead>
    <tbody>${roles.map(r => `<tr>
      <td><b>${esc(r.name)}</b></td>
      <td><code>${esc(r.code)}</code></td>
      <td>${lvlBadge(r.level)}</td>
      <td><div>${permTxt(r)}</div><div>${opsTxt(r)}</div></td>
      <td>${r.is_system
        ? '<span class="badge bg-info text-dark">系统内置</span>'
        : '<span class="badge bg-light text-dark">自定义</span>'}</td>
      <td>
        <button class="btn btn-sm btn-outline-primary" onclick="editRole(${r.id})">编辑</button>
        ${!r.is_system
          ? `<button class="btn btn-sm btn-outline-danger" onclick="delRole(${r.id})">删除</button>` : ''}
      </td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="text-muted small mt-2">
      <i class="bi bi-info-circle"></i> ① 自定义角色可配置页面访问与操作权限，分配该角色的员工自动获得；
      内置「员工」角色不可配置；已分配给员工的自定义角色需先调整后再删除。
    </div>`;
}

async function editRole(id){
  /* 新建角色默认页面参数：房产管理 / 账单收费 / 报修管理 / 网络管理 / 投诉建议（按当前系统可用项） */
  const DEF_ROLE_PAGES = ['properties', 'bills', 'repairs', 'network', 'complaints'];
  let data = { code:'', name:'', description:'', level:'staff',
    pages: DEF_ROLE_PAGES.filter(p => pageOpts(curMode()).some(o => o.value === p)), ops: [] };
  if (id){
    const roles = await api('/api/roles');
    data = roles.find(x => x.id === id) || data;
  }
  const isSys = id && Number(data.is_system);
  const isSuperEdit = ME.level === 'super';
  const fields = [
    { name:'name', label:'角色名称', required:true, placeholder:'如：财务',
      hint: isSys && !isSuperEdit ? '内置角色名称为系统共享，仅超管可修改；本次仅保存本经营主体的权限配置' : undefined },
    { name:'code', label:'角色编码', required:true, placeholder:'如：finance',
      hint: isSys ? '系统内置角色编码不可修改' : '仅字母/数字/下划线，以字母开头' }
  ];
  if (!isSys){
    fields.push({ name:'level', label:'角色等级', type:'select',
      options:[{ value:'staff', label:'员工' }, { value:'manager', label:'管理员' }],
      hint:'员工：普通业务操作；管理员：给企业管理员/物业管理员使用，权限同样按勾选' });
  }
  fields.push({ name:'description', label:'说明', type:'textarea', placeholder:'该角色的职责说明（可选）',
    hint: isSys && !isSuperEdit ? '说明为系统共享，仅超管可修改' : undefined });
  {
    const rolePageOpts = pageOpts(curMode());
    if (rolePageOpts.length){
      fields.push({ name:'pages', label:'角色权限', type:'checklist', options: rolePageOpts,
        hint: (isSys && !isSuperEdit ? '系统内置：仅修改本经营主体配置（不影响其他主体）。' : '')
          + '勾选后可访问对应页面；分配该角色的员工自动获得' });
    }
    const roleOpOpts = [];
    (OP_DEFS[curMode()] || []).forEach(g => {
      roleOpOpts.push({ type:'group', label:g.g });
      g.items.forEach(([value, label]) => roleOpOpts.push({ value, label }));
    });
    if (roleOpOpts.length){
      fields.push({ name:'ops', label:'操作权限', type:'checklist', options: roleOpOpts,
        hint: '勾选后拥有对应页面的操作按钮（如新增、编辑、删除、收款）' });
    }
  }
  openForm(id ? '编辑角色' : '新增角色', fields, data, async (d, modal) => {
    if (isSys) delete d.level;
    if (isSys) delete d.code;
    if (isSys && !isSuperEdit){ delete d.name; delete d.description; }
    await api(id ? '/api/roles/' + id : '/api/roles', id ? 'PUT' : 'POST', d);
    modal.hide(); renderRoles();
  }, (el) => {
    /* 联动提示：账单操作（手动添加/生成）依赖房产管理页面权限 */
    const propsCb = el.querySelector('input[name="pages"][value="properties"]');
    if (!propsCb) return;
    const needOps = ['bill_add', 'bill_generate'];
    const labels = {};
    (OP_DEFS[curMode()] || []).forEach(g => g.items.forEach(([v, l]) => { labels[v] = l; }));
    const tip = document.createElement('div');
    tip.className = 'form-text text-warning mt-1';
    const opsBox = el.querySelector('input[name="ops"]');
    const box = opsBox ? opsBox.closest('.mb-3') : null;
    if (!box) return;
    box.appendChild(tip);
    const sync = () => {
      const miss = needOps.filter(op => {
        const cb = el.querySelector(`input[name="ops"][value="${op}"]`);
        return cb && cb.checked && !propsCb.checked;
      });
      tip.textContent = miss.length
        ? '提示：勾选「' + miss.map(op => labels[op] || op).join('、') + '」需同时勾选「房产管理」页面权限，员工才能正常使用'
        : '';
    };
    needOps.forEach(op => {
      const cb = el.querySelector(`input[name="ops"][value="${op}"]`);
      if (cb) cb.addEventListener('change', sync);
    });
    propsCb.addEventListener('change', sync);
  });
}

async function delRole(id){
  if (!confirm('确定删除该角色？')) return;
  try { await api('/api/roles/' + id, 'DELETE'); renderRoles(); }
  catch(e){ alert(e.message); }
}

/* ==================================================================
 * 21. 员工工作台（员工独立页面）
 * ================================================================== */
async function renderStaffHome(){
  /* 工作台为员工基础首页：无仪表盘权限时显示占位（不阻断页面） */
  let s = {};
  try { s = await api('/api/stats'); } catch(e){}
  const mode = curMode();
  const cards = [
    ['总房间', s.total_rooms || 0, 'door-open', 'primary'],
    [mode === 'rental' ? '已出租' : '已入住', mode === 'rental' ? (s.rented || 0) : ((s.checked_in || s.rented) || 0), 'check-circle', 'success'],
    ['待处理报修', s.pending_repairs || 0, 'tools', 'danger'],
    ['本月应收', money(s.month_receivable || 0), 'wallet2', 'warning']
  ];
  let repairs = [];
  try { repairs = await api('/api/repairs'); } catch(e){}
  const todo = repairs.filter(r => r.status === 'pending').slice(0, 5);
  $('#page').innerHTML = `
  <div class="row g-3 mb-3">
    ${cards.map(c => `<div class="col-6 col-md-3"><div class="card shadow-sm h-100">
      <div class="card-body"><div class="text-muted small">${c[0]}</div>
        <div class="fs-4 fw-bold text-${c[3]}"><i class="bi bi-${c[2]}"></i> ${c[1]}</div></div></div></div>`).join('')}
  </div>
  <div class="card"><div class="card-header bg-white fw-bold"><i class="bi bi-tools"></i> 待处理报修</div>
    <div class="table-responsive"><table class="table table-hover mb-0">
      <thead class="table-light"><tr>
        <th>楼栋/房间</th><th>标题</th><th>问题描述</th><th>状态</th><th>报修时间</th></tr></thead>
      <tbody>
        ${todo.map(r => `<tr>
          <td><b>${esc(r.building_name || '')} ${esc(r.room_no || '-')}</b></td>
          <td>${esc(r.title)}</td>
          <td><small>${esc(r.content || '-')}</small></td>
          <td>${repairBadge(r.status)}</td>
          <td><small>${esc(r.created_at || '-')}</small></td></tr>`).join('')
          || '<tr><td colspan="5" class="text-center text-muted py-4">暂无待处理报修</td></tr>'}
      </tbody></table></div></div>`;
}

/* ==================================================================
 * 22. 系统监控（仅超管：聚合三系统核心运行指标）
 * ================================================================== */
async function renderMonitor(){
  const m = await api('/api/monitor');
  const sysCard = (key, name, icon) => {
    const s = m.systems[key];
    const row = (label, v, cls) => `<div class="d-flex justify-content-between py-1 border-bottom" style="font-size:13px">
      <span class="text-muted">${label}</span><b class="${cls || ''}">${v}</b></div>`;
    return `<div class="col-md-4"><div class="card h-100">
      <div class="card-header bg-white fw-bold"><i class="bi bi-${icon} text-primary"></i> ${name}</div>
      <div class="card-body py-2">
        ${row('总房间', s.total_rooms)}
        ${row('出租 / 入住', s.rented)}
        ${row('空置', s.vacant)}
        ${row('入住率', s.occupancy + '%', s.occupancy >= 60 ? 'text-success' : 'text-warning')}
        ${row('本月应收', money(s.month_receivable), 'text-primary')}
        ${row('本月已收', money(s.month_received), 'text-success')}
        ${row('累计欠费', money(s.arrears), Number(s.arrears) > 0 ? 'text-danger' : '')}
        ${row('待处理报修', s.pending_repairs, Number(s.pending_repairs) > 0 ? 'text-danger' : '')}
        ${key === 'property' ? row('待处理投诉', s.pending_complaints, Number(s.pending_complaints) > 0 ? 'text-danger' : '') : ''}
      </div></div></div>`;
  };
  const orgTable = (key, name) => {
    const list = (m.orgs && m.orgs[key]) || [];
    const rows = list.map(o => `<tr>
      <td><b>${esc(o.name)}</b></td>
      <td>${o.admin ? esc(o.admin.username) : '-'}<div class="text-muted small">${o.admin ? esc(o.admin.real_name || '') : ''}</div></td>
      <td>${o.total_rooms}</td>
      <td>${o.rented}</td>
      <td>${o.occupancy}%</td>
      <td>${money(o.month_receivable)}</td>
      <td>${money(o.month_received)}</td>
      <td class="${Number(o.arrears) > 0 ? 'text-danger' : ''}">${money(o.arrears)}</td>
      <td>${Number(o.pending_repairs) > 0 ? '<span class="text-danger">' + o.pending_repairs + '</span>' : 0}${key === 'property' && Number(o.pending_complaints) > 0 ? '<div class="small">投诉 ' + o.pending_complaints + '</div>' : ''}</td>
      <td>${o.staff_count}</td>
    </tr>`).join('') || `<tr><td colspan="10" class="text-center text-muted py-3">暂无经营主体</td></tr>`;
    return `<div class="card mb-3"><div class="card-header bg-white fw-bold">
      <i class="bi bi-building text-primary"></i> 经营主体 ${name}（${list.length}）</div>
      <div class="table-responsive" style="max-height:300px"><table class="table table-sm table-hover mb-0">
      <thead class="table-light"><tr>
        <th>主体名称</th><th>主管理员</th><th>房间</th><th>出租/入住</th><th>入住率</th>
        <th>本月应收</th><th>本月已收</th><th>累计欠费</th><th>待处理</th><th>员工</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div>`;
  };
  $('#page').innerHTML = `
  <div class="d-flex align-items-center gap-3 mb-3">
    <span class="badge bg-success"><i class="bi bi-heart-pulse"></i> 服务在线 · 数据库连接正常</span>
    <span class="text-muted small">更新时间：${esc(m.time)}</span>
    <button class="btn btn-sm btn-outline-primary ms-auto" onclick="renderMonitor()"><i class="bi bi-arrow-clockwise"></i> 刷新</button>
  </div>
  <div class="row g-3">
    ${sysCard('rental', '租房', 'house-door')}
    ${sysCard('hotel', '酒店', 'building')}
    ${sysCard('property', '物业', 'hdd-network')}
  </div>
  <h6 class="mt-4 mb-2 text-muted"><i class="bi bi-diagram-3"></i> 各系统经营主体明细（数据相互独立）</h6>
  ${orgTable('rental', '租房')}
  ${orgTable('hotel', '酒店')}
  ${orgTable('property', '物业')}`;
}

/* 系统设置（仅超管）：登录入口选择开关 + 隐藏后默认入口（为后续域名绑定系统预留） */
async function renderAppConfig(){
  const cfg = await api('/api/app-config');
  $('#page').innerHTML = `
  <div class="d-flex align-items-center gap-3 mb-3">
    <h5 class="mb-0"><i class="bi bi-gear text-primary"></i> 系统设置</h5>
    <span class="text-muted small">全局配置，对所有系统生效</span>
    <button class="btn btn-sm btn-outline-primary ms-auto" onclick="renderAppConfig()"><i class="bi bi-arrow-clockwise"></i> 刷新</button>
  </div>
  <div class="row">
    <div class="col-md-6">
      <div class="card">
        <div class="card-header bg-white fw-bold"><i class="bi bi-door-closed text-primary"></i> 登录入口选择</div>
        <div class="card-body">
          <div class="form-check form-switch mb-3">
            <input class="form-check-input" type="checkbox" id="cfgHideSelector" ${cfg.login_selector === 'hide' ? 'checked' : ''}>
            <label class="form-check-label" for="cfgHideSelector">隐藏登录入口选择</label>
            <div class="text-muted small mt-1">开启后，打开系统网址不再显示四个登录入口卡片，直接进入下方指定的默认登录窗口；入口地址仍可直达（#login-xxx）。</div>
          </div>
          <div class="mb-3">
            <label class="form-label">隐藏后默认登录入口</label>
            <select class="form-select" id="cfgLoginDefault">
              <option value="rental" ${cfg.login_default === 'rental' ? 'selected' : ''}>租房系统</option>
              <option value="hotel" ${cfg.login_default === 'hotel' ? 'selected' : ''}>酒店系统</option>
              <option value="property" ${cfg.login_default === 'property' ? 'selected' : ''}>物业综合管理系统</option>
              <option value="super" ${cfg.login_default === 'super' ? 'selected' : ''}>超级管理员</option>
            </select>
          </div>
          <button class="btn btn-primary" onclick="saveAppConfig()"><i class="bi bi-check-lg"></i> 保存</button>
        </div>
      </div>
    </div>
  </div>`;
}
async function saveAppConfig(){
  const selector = $('#cfgHideSelector').checked ? 'hide' : 'show';
  const def = $('#cfgLoginDefault').value;
  await api('/api/app-config', 'PUT', { login_selector: selector, login_default: def });
  APP_CFG = null; /* 清除缓存，下次登录页读取新值 */
  alert('已保存');
  renderAppConfig();
}

/* ==================================================================
 * 22c. 系统使用费（仅超管：收费模式/单价/周期/提醒/会话有效期/收款流水/主体计费）
 * 超期或关闭 → 除主管理员外所有登录停用，持续提醒（见后端 feeBlocked）
 * ================================================================== */
const FEE_CYCLE_TXT = { month:'按月', year:'按年', once:'一次性' };
function feeBadge(o){
  if (o.fee_status === 'closed') return '<span class="badge bg-danger">已关闭</span>';
  if (o.fee_status === 'paused') return '<span class="badge bg-warning text-dark">已暂停</span>';
  if (o.fee_due && o.fee_due < today()) return '<span class="badge bg-danger">已超期</span>';
  if (o.fee_due && o.fee_due === today()) return '<span class="badge bg-warning text-dark">今日到期</span>';
  return '<span class="badge bg-success">正常</span>';
}
async function renderFee(){
  const [cfg, orgs, pays] = await Promise.all([api('/api/fee-config'), api('/api/fee-orgs'), api('/api/fee-payments')]);
  const sym = cfg.currency === 'CNY' ? '¥' : '$';
  const m = n => sym + (Number(n) || 0).toFixed(2);
  const rows = orgs.map(o => `<tr>
    <td><b>${esc(o.name)}</b></td>
    <td>${MODE_NAME[o.mode]}</td>
    <td>${FEE_CYCLE_TXT[o.fee_cycle] || o.fee_cycle}</td>
    <td>${m(o.fee_price)}</td>
    <td>${o.fee_start || '-'}</td>
    <td>${o.fee_due || (o.fee_cycle === 'once' ? '长期' : '-')}</td>
    <td>${m(o.due)}</td>
    <td>${m(o.paid)}</td>
    <td class="${o.balance > 0 ? 'text-danger fw-bold' : ''}">${m(o.balance)}</td>
    <td>${feeBadge(o)}</td>
    <td class="text-nowrap">
      <button class="btn btn-sm btn-outline-primary" onclick="addFeePay(${o.id}, '${esc(o.name)}')">登记收款</button>
      <button class="btn btn-sm btn-outline-secondary" onclick="editFeeOrg(${o.id})">计费设置</button>
    </td></tr>`).join('')
    || '<tr><td colspan="11" class="text-center text-muted py-3">暂无经营主体</td></tr>';
  $('#page').innerHTML = `
  <div class="d-flex align-items-center gap-3 mb-3">
    <h5 class="mb-0"><i class="bi bi-cash-stack text-primary"></i> 系统使用费</h5>
    <span class="text-muted small">超期自动停用除主管理员外的所有登录，持续提醒</span>
    <button class="btn btn-sm btn-outline-primary ms-auto" onclick="renderFee()"><i class="bi bi-arrow-clockwise"></i> 刷新</button>
  </div>
  <div class="card mb-3">
    <div class="card-header bg-white fw-bold"><i class="bi bi-sliders text-primary"></i> 收费配置（全局）</div>
    <div class="card-body">
      <div class="row g-2 align-items-end">
        <div class="col-auto"><label class="form-label small">收费模式</label>
          <select class="form-select form-select-sm" id="feeMode">
            <option value="free" ${cfg.fee_mode === 'free' ? 'selected' : ''}>免费（不限制登录）</option>
            <option value="paid" ${cfg.fee_mode === 'paid' ? 'selected' : ''}>收费（超期停用）</option>
          </select></div>
        <div class="col-auto"><label class="form-label small">默认周期</label>
          <select class="form-select form-select-sm" id="feeCycle">
            <option value="month" ${cfg.cycle === 'month' ? 'selected' : ''}>按月</option>
            <option value="year" ${cfg.cycle === 'year' ? 'selected' : ''}>按年</option>
            <option value="once" ${cfg.cycle === 'once' ? 'selected' : ''}>一次性</option>
          </select></div>
        <div class="col-auto"><label class="form-label small">租房单价</label>
          <input id="feeRp" type="number" class="form-control form-control-sm" style="width:90px" value="${cfg.rental_price}"></div>
        <div class="col-auto"><label class="form-label small">酒店单价</label>
          <input id="feeHp" type="number" class="form-control form-control-sm" style="width:90px" value="${cfg.hotel_price}"></div>
        <div class="col-auto"><label class="form-label small">物业单价</label>
          <input id="feePp" type="number" class="form-control form-control-sm" style="width:90px" value="${cfg.property_price}"></div>
        <div class="col-auto"><label class="form-label small">提前提醒(天)</label>
          <input id="feeRemind" type="number" class="form-control form-control-sm" style="width:80px" value="${cfg.remind_days}"></div>
        <div class="col-auto"><label class="form-label small">会话有效期(天)</label>
          <input id="feeSession" type="number" class="form-control form-control-sm" style="width:80px" value="${cfg.session_days}"></div>
        <div class="col-auto"><label class="form-label small">使用费货币</label>
          <select class="form-select form-select-sm" id="feeCur">
            <option value="USD" ${cfg.currency === 'USD' ? 'selected' : ''}>美元 $</option>
            <option value="CNY" ${cfg.currency === 'CNY' ? 'selected' : ''}>人民币 ¥</option>
          </select></div>
        <div class="col-auto"><button class="btn btn-sm btn-primary" onclick="saveFeeConfig()"><i class="bi bi-check-lg"></i> 保存配置</button></div>
      </div>
      <div class="text-muted small mt-2"><i class="bi bi-info-circle"></i> 主体可单独设置周期与单价（计费设置），未设置时按系统默认；登记收款后到期日自动顺延。</div>
    </div>
  </div>
  <div class="table-responsive"><table class="table table-hover">
    <thead class="table-light"><tr>
      <th>经营主体</th><th>系统</th><th>周期</th><th>单价</th><th>计费开始</th><th>到期日</th>
      <th>应收</th><th>实收</th><th>欠费</th><th>状态</th><th width="220">操作</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
  <div class="card mt-3"><div class="card-header bg-white fw-bold"><i class="bi bi-receipt text-primary"></i> 收款流水</div>
    <div class="card-body py-2 small">${pays.length ? pays.slice(0, 20).map(p =>
      `<div class="d-flex justify-content-between border-bottom py-1">
        <span>${esc(p.org_name)} · ${m(p.amount)} · ${esc(p.pay_method || '现金')} · ${p.pay_date}
          ${p.remark ? '· ' + esc(p.remark) : ''}</span>
        <span class="text-nowrap"><span class="text-muted me-2">${esc(p.operator || '')}</span>
          <a class="text-danger" onclick="delFeePay(${p.id})">撤销</a></span></div>`).join('')
      : '<div class="text-muted">暂无收款记录</div>'}</div></div>`;
}
async function saveFeeConfig(){
  try {
    await api('/api/fee-config', 'PUT', {
      fee_mode: $('#feeMode').value, cycle: $('#feeCycle').value,
      rental_price: Number($('#feeRp').value), hotel_price: Number($('#feeHp').value),
      property_price: Number($('#feePp').value),
      remind_days: Number($('#feeRemind').value), session_days: Number($('#feeSession').value),
      currency: $('#feeCur').value
    });
    alert('已保存（修改会话有效期后，已登录会话按新天数生效）');
    renderFee();
  } catch(e){ alert(e.message); }
}
async function addFeePay(orgId, orgName){
  openForm('登记收款 · ' + orgName, [
    { name:'amount', label:'收款金额', type:'number', required:true, step:'0.01', placeholder:'必须大于 0' },
    { name:'pay_method', label:'收款方式', type:'select', options:[
      { value:'现金', label:'现金' }, { value:'转账', label:'转账' }, { value:'银行', label:'银行' },
      { value:'微信', label:'微信' }, { value:'支付宝', label:'支付宝' } ] },
    { name:'pay_date', label:'收款日期', type:'date', required:true },
    { name:'remark', label:'备注' }
  ], { pay_date: today(), pay_method: '现金' }, async (d, modal) => {
    try {
      await api('/api/fee-payments', 'POST', { org_id: orgId, ...d });
      modal.hide(); renderFee();
    } catch(e){ alert(e.message); }
  });
}
async function editFeeOrg(id){
  const list = await api('/api/fee-orgs');
  const o = list.find(x => x.id === id);
  if (!o){ alert('经营主体不存在'); return; }
  openForm('计费设置 · ' + o.name, [
    { name:'fee_cycle', label:'计费周期', type:'select', options:[
      { value:'month', label:'按月' }, { value:'year', label:'按年' }, { value:'once', label:'一次性' } ] },
    { name:'fee_price', label:'单价（0=按系统默认）', type:'number', step:'0.01' },
    { name:'fee_start', label:'计费开始日', type:'date' },
    { name:'fee_due', label:'当前到期日（留空=长期有效）', type:'date',
      hint:'选择计费周期或计费开始日后，到期日自动按周期推算（一次性=长期有效），可手动修改' },
    { name:'fee_status', label:'状态', type:'select', options:[
      { value:'active', label:'正常' }, { value:'paused', label:'暂停（仅主管理员可登录）' },
      { value:'closed', label:'关闭（全部停用）' } ] }
  ], { id:o.id, fee_cycle:o.fee_cycle, fee_price:o.fee_price || '', fee_start:o.fee_start || '', fee_due:o.fee_due || '', fee_status:o.fee_status }, async (d, modal) => {
    try {
      await api('/api/fee-orgs/' + id, 'PUT', {
        fee_cycle:d.fee_cycle, fee_price:Number(d.fee_price) || 0,
        fee_start:d.fee_start || null, fee_due:d.fee_due || null, fee_status:d.fee_status
      });
      modal.hide(); renderFee();
    } catch(e){ alert(e.message); }
  }, (el) => {
    /* 日期联动：周期/开始日变化时自动推算到期日（一次性=长期有效）；
     * 到期日已有值（编辑场景）或用户手动改过 → 不再自动覆盖，始终可手动修改 */
    const cyc = el.querySelector('[name=fee_cycle]');
    const start = el.querySelector('[name=fee_start]');
    const due = el.querySelector('[name=fee_due]');
    if (!cyc || !start || !due) return;
    let manual = !!due.value; /* 已有到期日视为手动设定，不自动覆盖 */
    const calc = () => {
      const c = cyc.value;
      if (c === 'once'){ due.value = ''; return; }
      if (manual) return;
      if (!start.value) start.value = today(); /* 开始日未填时自动填今天 */
      due.value = c === 'year' ? addMonths(start.value, 12) : addMonths(start.value, 1);
    };
    cyc.addEventListener('change', calc);
    start.addEventListener('change', calc);
    due.addEventListener('input', () => { manual = true; });
  });
}
async function delFeePay(id){
  if (!confirm('确定撤销这条收款记录？')) return;
  try { await api('/api/fee-payments/' + id, 'DELETE'); renderFee(); }
  catch(e){ alert(e.message); }
}

/* ==================================================================
 * 22b. 经营主体管理（仅超管：开通/编辑/停用主管理员 = 开通一个独立租户）
 * ================================================================== */
async function renderOrgs(){
  const list = await api('/api/orgs');
  const grouped = { rental: [], hotel: [], property: [] };
  list.forEach(o => grouped[o.mode].push(o));
  const section = (mode, name, icon) => {
    const rows = grouped[mode].map(o => `<tr>
      <td><b>${esc(o.name)}</b></td>
      <td>${o.admin ? esc(o.admin.username) : '-'}</td>
      <td>${o.admin ? esc(o.admin.real_name || '-') : '-'}</td>
      <td>${o.room_count}</td>
      <td>${o.bill_count}</td>
      <td>${o.staff_count}</td>
      <td><small class="text-muted">${esc((o.created_at || '').slice(0, 16))}</small></td>
      <td>
        <button class="btn btn-sm btn-outline-primary" onclick="editOrg(${o.id})">编辑/重置密码</button>
        <button class="btn btn-sm btn-outline-danger" onclick="delOrg(${o.id})">删除</button>
      </td></tr>`).join('')
      || `<tr><td colspan="8" class="text-center text-muted py-3">暂无${name}经营主体</td></tr>`;
    return `<div class="card mb-3"><div class="card-header bg-white fw-bold">
      <i class="bi bi-${icon} text-primary"></i> 经营主体 ${name}（${grouped[mode].length}）</div>
      <div class="table-responsive"><table class="table table-hover mb-0">
      <thead class="table-light"><tr>
        <th>经营主体</th><th>管理员账号</th><th>管理员姓名</th>
        <th>房间</th><th>账单</th><th>员工</th><th>开通时间</th><th width="200">操作</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div>`;
  };
  $('#page').innerHTML = `
  <div class="mb-3 d-flex gap-2">
    <button class="btn btn-sm btn-primary" onclick="editOrg()"><i class="bi bi-plus-lg"></i> 开通主管理员（经营主体）</button>
    <div class="text-muted small align-self-center">
      开通后即创建一套<b>完全独立</b>的数据、系统设置与角色权限；主管理员从对应系统的登录入口进入，互不可见。
    </div>
  </div>
  ${section('rental', '租房', 'house-door')}
  ${section('hotel', '酒店', 'building')}
  ${section('property', '物业', 'hdd-network')}`;
}

async function editOrg(id){
  let data = { mode:'rental' };
  if (id){
    const list = await api('/api/orgs');
    const o = list.find(x => x.id === id);
    if (!o){ alert('经营主体不存在'); return; }
    data = { id:o.id, name:o.name, mode:o.mode, username:o.admin ? o.admin.username : '',
             real_name:o.admin ? o.admin.real_name : '' };
    openForm('编辑经营主体', [
      { name:'name', label:'经营主体名称', required:true },
      { name:'real_name', label:'主管理员姓名' },
      { name:'password', label:'重置主管理员密码（留空不修改）', type:'password', placeholder:'至少 6 位' }
    ], data, async (d, modal) => {
      await api('/api/orgs/' + id, 'PUT', { name:d.name, real_name:d.real_name, password:d.password || undefined });
      modal.hide(); renderOrgs();
    });
    return;
  }
  openForm('开通主管理员（经营主体）', [
    { name:'mode', label:'所属系统', type:'select', required:true, options:[
      { value:'rental', label:'租房' }, { value:'hotel', label:'酒店' }, { value:'property', label:'物业' } ] },
    { name:'name', label:'经营主体名称', required:true, placeholder:'如：金边1号公寓 / XX酒店 / XX物业' },
    { name:'real_name', label:'主管理员姓名' },
    { name:'username', label:'主管理员登录账号', required:true, placeholder:'仅字母数字，全局唯一' },
    { name:'password', label:'初始密码', type:'password', required:true, placeholder:'至少 6 位' }
  ], data, async (d, modal) => {
    try {
      await api('/api/orgs', 'POST', d);
      modal.hide(); renderOrgs();
    } catch(e){ alert(e.message); }
  });
}

async function delOrg(id){
  const list = await api('/api/orgs');
  const o = list.find(x => x.id === id);
  if (!o) return;
  if (!confirm(`确定删除经营主体「${o.name}」？\n该主体的主管理员、员工、全部业务数据、系统设置与角色将被永久删除，且不可恢复！`)) return;
  if (!confirm(`再次确认：删除「${o.name}」的所有数据？此操作不可撤销。`)) return;
  try { await api('/api/orgs/' + id, 'DELETE'); renderOrgs(); }
  catch(e){ alert(e.message); }
}

