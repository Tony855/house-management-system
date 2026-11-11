'use strict';
/* ==================================================================
 * 11. 租客 / 房客 / 企业（物业：企业管理 = 企业 Tab + 企业员工 Tab）
 * ================================================================== */
let tenantKeyword = '';
let ORG_TAB = 'owners';   /* 物业企业管理页 Tab：owners=企业列表，orgemp=企业员工 */

async function renderTenants(){
  const mode = curMode();
  if (mode === 'property') return renderPropertyCompanies();
  const qs = tenantKeyword ? '?keyword=' + encodeURIComponent(tenantKeyword) : '';
  const list = await api('/api/tenants' + qs);

  const label = mode === 'hotel' ? '房客' : '租客';
  const roomCol = mode === 'hotel' ? '在住房间' : '在租房间';

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <input class="form-control form-control-sm" placeholder="姓名 / 电话，回车搜索" value="${esc(tenantKeyword)}"
               onkeydown="if(event.key==='Enter'){tenantKeyword=this.value;renderTenants()}">
      </div>
      <div class="col-auto">${canOp('tenant_add') ? `<button class="btn btn-sm btn-primary" onclick="editTenant()">+ 新增${label}</button>` : ''}</div>
      <div class="col-auto text-muted small">共 ${list.length} 人</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>姓名</th><th>性别</th><th>电话</th><th>身份证号</th>
      <th>${roomCol}</th><th>备注</th>${canAnyOp('tenant_add','tenant_edit','tenant_delete') ? '<th width="160">操作</th>' : ''}</tr></thead>
    <tbody>${list.map(t => `<tr>
      <td><b>${esc(t.name)}</b></td><td>${esc(t.gender || '-')}</td>
      <td>${esc(t.phone || '-')}</td><td>${esc(t.id_card || '-')}</td>
      <td>${t.rooms ? esc(t.rooms) : '<span class="text-muted">-</span>'}</td>
      <td>${esc(t.remark || '-')}</td>
      <td>${canAnyOp('tenant_add','tenant_edit','tenant_delete') ? `
        ${canOp('tenant_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editTenant(${t.id})">编辑</button>` : ''}
        ${canOp('tenant_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delTenant(${t.id})">删除</button>` : ''}` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

/* ---------- 物业：企业管理（企业 Tab + 企业员工 Tab，数据按主体隔离） ---------- */
async function renderPropertyCompanies(){
  const qs = tenantKeyword ? '?keyword=' + encodeURIComponent(tenantKeyword) : '';
  const canEmp = pageAllowed('orgemp');   /* 主管理员恒 true；员工需被授权 */
  const companies = await api('/api/tenants' + qs);
  const empList = (canEmp && ORG_TAB === 'orgemp') ? await api('/api/org-employees') : [];
  const tab = (id, name, icon) => `
    <button class="btn btn-sm ${ORG_TAB === id ? 'btn-primary' : 'btn-outline-secondary'}"
            onclick="ORG_TAB='${id}';renderTenants()">
      <i class="bi bi-${icon}"></i> ${name}</button>`;
  if (ORG_TAB === 'orgemp'){
    /* ---------- 企业员工 Tab ---------- */
    const roomsByOwner = {};
    const roomOpts = companies;
    $('#page').innerHTML = `
    <div class="card mb-3"><div class="card-body py-2">
      <div class="row g-2 align-items-center">
        <div class="col-auto"><div class="btn-group">${tab('owners','企业','building')}${canEmp ? tab('orgemp','企业员工','person-vcard') : ''}</div></div>
        <div class="col-auto">${canOp('orgemp_add') ? `<button class="btn btn-sm btn-primary" onclick="editOrgEmp()">+ 新增企业员工</button>` : ''}</div>
        <div class="col-auto text-muted small">共 ${empList.length} 名企业员工</div>
      </div>
    </div></div>
    <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
      <thead class="table-light"><tr>
        <th>照片</th><th>所属企业</th><th>姓名</th><th>身份证/护照</th><th>电话</th>
        <th>部门</th><th>职位</th><th>门禁卡</th><th>绑定房号</th>${canAnyOp('orgemp_add','orgemp_edit','orgemp_delete') ? '<th width="160">操作</th>' : ''}</tr></thead>
      <tbody>${empList.map(e => `<tr>
        <td>${e.photo_url ? `<img src="${esc(e.photo_url)}" class="rounded" style="width:36px;height:36px;object-fit:cover">`
                           : '<span class="text-muted">-</span>'}</td>
        <td><b>${esc(e.company)}</b></td>
        <td>${esc(e.name)}</td>
        <td>${esc(e.id_number || '-')}</td>
        <td>${esc(e.phone || '-')}</td>
        <td>${esc(e.department || '-')}</td>
        <td>${esc(e.position || '-')}</td>
        <td>${esc(e.card_no || '-')}</td>
        <td>${e.room_no ? esc((e.building_name || '') + ' ' + e.room_no) : (e.owner_name ? `<span class="text-muted">（${esc(e.owner_name)}）</span>` : '-')}</td>
        ${canAnyOp('orgemp_add','orgemp_edit','orgemp_delete') ? `<td>
          ${canOp('orgemp_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editOrgEmp(${e.id})">编辑</button>` : ''}
          ${canOp('orgemp_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delOrgEmp(${e.id})">删除</button>` : ''}
        </td>` : ''}</tr>`).join('') || '<tr><td colspan="10" class="text-center text-muted py-4">暂无企业员工</td></tr>'}
      </tbody></table></div></div>`;
    return;
  }
  /* ---------- 企业 Tab（物业业主 = 企业客户） ---------- */
  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto"><div class="btn-group">${tab('owners','企业','building')}${canEmp ? tab('orgemp','企业员工','person-vcard') : ''}</div></div>
      <div class="col-auto">
        <input class="form-control form-control-sm" placeholder="企业名称 / 电话，回车搜索" value="${esc(tenantKeyword)}"
               onkeydown="if(event.key==='Enter'){tenantKeyword=this.value;renderTenants()}">
      </div>
      <div class="col-auto">${canOp('tenant_add') ? `<button class="btn btn-sm btn-primary" onclick="editTenant()">+ 新增企业</button>` : ''}</div>
      <div class="col-auto text-muted small">共 ${companies.length} 家企业</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>企业名称</th><th>联系人</th><th>电话</th><th>营业执照/信用代码</th>
      <th>名下房产</th><th>企业员工</th><th>备注</th>${canAnyOp('tenant_add','tenant_edit','tenant_delete') ? '<th width="280">操作</th>' : ''}</tr></thead>
    <tbody>${companies.map(t => `<tr>
      <td><b>${esc(t.name)}</b></td>
      <td>${esc(t.contact || '-')}</td>
      <td>${esc(t.phone || '-')}</td>
      <td>${esc(t.license_no || '-')}</td>
      <td>${t.rooms ? esc(t.rooms) : '<span class="text-muted">-</span>'}</td>
      <td>${t.emp_count !== undefined ? t.emp_count : 0}</td>
      <td>${esc(t.remark || '-')}</td>
      ${canAnyOp('tenant_add','tenant_edit','tenant_delete') ? `<td>
        ${canOp('tenant_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editTenant(${t.id})">编辑</button>` : ''}
        ${canOp('tenant_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delTenant(${t.id})">删除</button>` : ''}
        ${canOp('tenant_edit') ? `<button class="btn btn-sm btn-outline-success" onclick="setCompanyAdmin(${t.id})">
          ${t.admin_username ? '管理员：' + esc(t.admin_username) : '设管理员'}</button>` : ''}
      </td>` : ''}</tr>`).join('') || '<tr><td colspan="8" class="text-center text-muted py-4">暂无企业</td></tr>'}
    </tbody></table></div></div>`;
}

/* ---------- 企业管理员账号设置（仅主管理员；企业管理员登录后只读本企业数据） ---------- */
async function setCompanyAdmin(id){
  const companies = await api('/api/tenants');
  const comp = companies.find(c => c.id === id);
  if (!comp) return alert('企业不存在');
  const has = !!comp.admin_username;
  const data = { username: comp.admin_username || '', real_name: '', password: '' };
  openForm(has ? '重置企业管理员（' + comp.name + '）' : '设置企业管理员（' + comp.name + '）',
    [
      { name:'username', label:'登录用户名', required:true, hint: has ? '当前账号，可修改' : '以字母开头，3-20位字母/数字/下划线' },
      { name:'real_name', label:'姓名' },
      { name:'password', label:'密码', type:'password', required:true, hint:'至少 6 位；企业管理员仅可查看本企业数据（只读）' }
    ], data, async (d, modal) => {
      await api('/api/tenants/' + id + '/company-admin', 'POST', d);
      modal.hide(); renderTenants();
    });
}

/* ---------- 企业员工表单（照片上传 + 绑定企业房号联动） ---------- */
async function editOrgEmp(id){
  const [companies, allRooms] = await Promise.all([api('/api/tenants'), api('/api/rooms')]);
  const empList = id ? await api('/api/org-employees') : [];
  let data = { company:'', owner_id:'', room_id:'', name:'', id_number:'', phone:'',
               department:'', position:'', card_no:'', photo_url:'', id_photo_url:'', remark:'' };
  if (id) data = empList.find(x => x.id === id) || data;
  /* 绑定房号：仅列所选企业名下房产（rooms.owner_id 关联企业） */
  const byOwner = {};
  allRooms.forEach(r => {
    if (r.owner_id) (byOwner[r.owner_id] = byOwner[r.owner_id] || [])
      .push({ value:String(r.id), label:(r.building_name || '') + ' ' + r.room_no });
  });
  const roomSelect = { name:'room_id', label:'绑定房号', type:'select',
    options: [{ value:'', label:'-- 不绑定 --' }] };
  const fields = [
    { name:'company', label:'所属企业', required:true, placeholder:'企业名称，不存在将自动创建该企业',
      hint:'企业将自动记录到「企业」列表，并在企业名下房产绑定房号' },
    { name:'name', label:'姓名', required:true },
    { name:'id_number', label:'身份证 / 护照' },
    { name:'phone', label:'电话' },
    { name:'department', label:'部门' },
    { name:'position', label:'职位' },
    { name:'card_no', label:'门禁卡号' },
    { name:'photo_url', label:'本人照片', type:'file' },
    { name:'id_photo_url', label:'身份证/护照照片', type:'file' },
    roomSelect,
    { name:'remark', label:'备注', type:'textarea' }
  ];
  openForm(id ? '编辑企业员工' : '新增企业员工', fields, data, async (d, modal) => {
    await api(id ? '/api/org-employees/' + id : '/api/org-employees', id ? 'PUT' : 'POST', d);
    modal.hide(); renderTenants();
  }, (el) => {
    /* 企业名变化 → 匹配企业 → 刷新房号下拉（仅该企业名下房产） */
    const companyIn = el.querySelector('input[name=company]');
    const roomSel = el.querySelector('select[name=room_id]');
    if (!companyIn || !roomSel) return;
    const fillRooms = (company) => {
      const c = companies.find(x => x.name === company);
      const opts = [{ value:'', label:'-- 不绑定 --' }];
      if (c && byOwner[c.id]) opts.push(...byOwner[c.id]);
      const cur = roomSel.value;
      roomSel.innerHTML = opts.map(o => `<option value="${esc(o.value)}" ${o.value === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    };
    companyIn.addEventListener('input', () => fillRooms(companyIn.value.trim()));
    fillRooms(data.company);
  });
}

async function delOrgEmp(id){
  if (!confirm('确定删除该企业员工？')) return;
  try { await api('/api/org-employees/' + id, 'DELETE'); renderTenants(); }
  catch(e){ alert(e.message); }
}

async function editTenant(id){
  const mode = curMode();
  if (mode === 'property'){
    let data = { name:'', contact:'', phone:'', license_no:'', remark:'' };
    if (id){ const list = await api('/api/tenants'); data = list.find(x => x.id === id) || data; }
    openForm(id ? '编辑企业' : '新增企业', [
      { name:'name', label:'企业名称', required:true },
      { name:'contact', label:'联系人' },
      { name:'phone', label:'联系电话' },
      { name:'license_no', label:'营业执照 / 统一信用代码' },
      { name:'remark', label:'备注', type:'textarea' }
    ], data, async (d, modal) => {
      await api(id ? '/api/tenants/' + id : '/api/tenants', id ? 'PUT' : 'POST', d);
      modal.hide(); renderTenants();
    });
    return;
  }
  let data = { gender:'男' };
  if (id){ const list = await api('/api/tenants'); data = list.find(x => x.id === id) || data; }
  openForm(id ? '编辑资料' : '新增资料', [
    { name:'name', label:'姓名', required:true },
    { name:'gender', label:'性别', type:'select', options:[
      { value:'男', label:'男' }, { value:'女', label:'女' }] },
    { name:'phone', label:'联系电话', required:true },
    { name:'id_card', label:'身份证号' },
    { name:'remark', label:'备注', type:'textarea' }
  ], data, async (d, modal) => {
    await api(id ? '/api/tenants/' + id : '/api/tenants', id ? 'PUT' : 'POST', d);
    modal.hide(); renderTenants();
  });
}

async function delTenant(id){
  if (!confirm('确定删除该记录？')) return;
  try { await api('/api/tenants/' + id, 'DELETE'); renderTenants(); }
  catch(e){ alert(e.message); }
}

/* ==================================================================
 * 12. 合同
 * ================================================================== */
let contractFilter = '';

async function renderContracts(){
  const qs = contractFilter ? '?status=' + contractFilter : '';
  const list = await api('/api/contracts' + qs);

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="contractFilter=this.value;renderContracts()">
          <option value="">全部合同</option>
          <option value="active"     ${contractFilter === 'active' ? 'selected' : ''}>履行中</option>
          <option value="expired"    ${contractFilter === 'expired' ? 'selected' : ''}>已到期</option>
          <option value="terminated" ${contractFilter === 'terminated' ? 'selected' : ''}>已终止</option>
        </select>
      </div>
      <div class="col-auto">${canOp('contract_add') ? `<button class="btn btn-sm btn-primary" onclick="editContract()">+ 新签合同</button>` : ''}</div>
      <div class="col-auto text-muted small">共 ${list.length} 份</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>合同编号</th><th>楼栋/房间</th><th>租客</th><th>电话</th><th>租期</th>
      <th>月租</th><th>押金</th><th>付款方式</th><th>状态</th>${canAnyOp('contract_add','contract_edit','contract_delete') ? '<th width="220">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(c => `<tr>
      <td><small>${esc(c.contract_no)}</small></td>
      <td><b>${esc(c.building_name || '')} ${esc(c.room_no || '')}</b></td>
      <td>${esc(c.tenant_name)}</td>
      <td>${esc(c.tenant_phone || '-')}</td>
      <td><small>${c.start_date} ~ ${c.end_date}</small></td>
      <td>${money(c.rent)}</td>
      <td>${money(c.deposit)}</td>
      <td>${cycleText(c.pay_cycle)}</td>
      <td>${contractBadge(c.status)}</td>
      <td>${canAnyOp('contract_add','contract_edit','contract_delete') ? `
        ${c.status === 'active' && canOp('contract_delete')
          ? `<button class="btn btn-sm btn-outline-danger" onclick="terminateContract(${c.id})">终止</button>` : ''}
        ${canOp('contract_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editContract(${c.id})">编辑</button>` : ''}` : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

async function editContract(id, presetRoomId){
  const [rooms, tenants] = await Promise.all([api('/api/rooms'), api('/api/tenants')]);
  if (!tenants.length){ alert('请先添加租客'); return; }

  const t = today();
  let data = { pay_cycle: 1, sign_date: t, start_date: t,
               end_date: addMonths(t, 12), rent: 0, deposit: 0 };
  if (id){
    const list = await safeApi('/api/contracts');
    if (!list) return;
    data = list.find(x => x.id === id) || data;
  }
  if (presetRoomId) data.room_id = presetRoomId;

  const avail = rooms.filter(r => r.status === 'vacant' || r.id === Number(data.room_id));
  if (!avail.length){ alert('没有空置房间可签约'); return; }
  if (!data.room_id) data.room_id = avail[0].id;
  if (!data.rent){
    const r = rooms.find(r => r.id === Number(data.room_id));
    data.rent = r ? r.rent : 0;
    data.deposit = r ? r.deposit : 0;
  }

  openForm(id ? '编辑合同' : '新签合同', [
    { name:'room_id', label:'房间', type:'select', required:true,
      options: avail.map(r => ({ value:r.id,
        label:`${r.building_name || ''} ${r.room_no}（${money(r.rent)}/月）` })) },
    { name:'tenant_id', label:'租客', type:'select', required:true,
      options: tenants.map(x => ({ value:x.id, label:`${x.name} ${x.phone || ''}` })) },
    { name:'start_date', label:'起租日期', type:'date', required:true },
    { name:'end_date', label:'到期日期', type:'date', required:true },
    { name:'rent', label:'月租金', type:'number', required:true, step:'0.01', money:true },
    { name:'deposit', label:'押金', type:'number', step:'0.01', money:true },
    { name:'pay_cycle', label:'付款周期', type:'select', options:[
      { value:1, label:'月付' }, { value:3, label:'季付' },
      { value:6, label:'半年付' }, { value:12, label:'年付' }] },
    { name:'sign_date', label:'签约日期', type:'date' },
    { name:'remark', label:'备注', type:'textarea' }
  ], data, async (d, modal) => {
    if (d.end_date <= d.start_date){ alert('到期日期必须晚于起租日期'); return; }
    await api(id ? '/api/contracts/' + id : '/api/contracts', id ? 'PUT' : 'POST', d);
    modal.hide(); renderContracts();
  });
}

async function terminateContract(id){
  if (!confirm('确定终止该合同？房间将变为空置状态。')) return;
  await api(`/api/contracts/${id}/terminate`, 'POST');
  renderContracts();
}

/* ==================================================================
 * 13. 订单
 * ================================================================== */
let orderFilter = '';

async function renderOrders(){
  const qs = orderFilter ? '?status=' + orderFilter : '';
  const list = await api('/api/orders' + qs);

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="orderFilter=this.value;renderOrders()">
          <option value="">全部订单</option>
          <option value="booked"      ${orderFilter === 'booked' ? 'selected' : ''}>已预订</option>
          <option value="checked_in"  ${orderFilter === 'checked_in' ? 'selected' : ''}>已入住</option>
          <option value="checked_out" ${orderFilter === 'checked_out' ? 'selected' : ''}>已退房</option>
          <option value="cancelled"   ${orderFilter === 'cancelled' ? 'selected' : ''}>已取消</option>
        </select>
      </div>
      <div class="col-auto">${canOp('order_add') ? `<button class="btn btn-sm btn-primary" onclick="editOrder()">+ 新增预订</button>` : ''}</div>
      <div class="col-auto text-muted small">共 ${list.length} 单</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>订单号</th><th>楼栋/房间</th><th>房客</th><th>入住</th><th>退房</th>
      <th>天数</th><th>房价/天</th><th>总价</th><th>押金</th><th>状态</th>${canAnyOp('order_add','order_edit','order_status','order_delete') ? '<th width="230">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(o => `<tr>
      <td><small>${esc(o.order_no)}</small></td>
      <td><b>${esc(o.building_name || '')} ${esc(o.room_no || '')}</b></td>
      <td>${esc(o.guest_name)}</td>
      <td>${o.check_in_date}</td>
      <td>${o.check_out_date}</td>
      <td>${o.days} 天</td>
      <td>${money(o.day_price)}</td>
      <td><b class="text-primary">${money(o.total)}</b></td>
      <td>${money(o.deposit)}</td>
      <td>${orderBadge(o.status)}</td>
      <td>${canAnyOp('order_add','order_edit','order_status','order_delete') ? `
        ${o.status === 'booked' ? `
          ${canOp('order_status') ? `<button class="btn btn-sm btn-success" onclick="checkinOrder(${o.id})">入住</button>
          <button class="btn btn-sm btn-outline-secondary" onclick="cancelOrder(${o.id})">取消</button>` : ''}
          ${canOp('order_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editOrder(${o.id})">编辑</button>` : ''}` : ''}
        ${o.status === 'checked_in' ? `
          ${canOp('order_status') ? `<button class="btn btn-sm btn-warning" onclick="checkoutOrder(${o.id})">退房</button>` : ''}` : ''}
        ${o.status === 'checked_out' || o.status === 'cancelled' ? `
          ${canOp('order_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delOrder(${o.id})">删除</button>` : ''}` : ''}` : ''}
      </td></tr>`).join('') || '<tr><td colspan="11" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

async function editOrder(id, presetRoomId){
  const [rooms, guests] = await Promise.all([api('/api/rooms'), api('/api/tenants')]);
  if (!guests.length){ alert('请先添加房客'); return; }

  const t = today();
  let data = { check_in_date: t, check_out_date: addDays(t, 1), day_price: 0, deposit: 0 };
  if (id){
    const list = await api('/api/orders');
    data = list.find(x => x.id === id) || data;
  }
  if (presetRoomId) data.room_id = presetRoomId;

  const avail = rooms.filter(r =>
    r.status === 'vacant' || r.status === 'booked' || r.id === Number(data.room_id));
  if (!avail.length){ alert('没有可预订的房间'); return; }
  if (!data.room_id) data.room_id = avail[0].id;
  if (!data.day_price){
    const r = rooms.find(r => r.id === Number(data.room_id));
    data.day_price = r ? (r.day_price || r.rent || 0) : 0;
  }

  openForm(id ? '编辑订单' : '新增预订', [
    { name:'room_id', label:'房间', type:'select', required:true,
      options: avail.map(r => ({ value:r.id,
        label:`${r.building_name || ''} ${r.room_no}（${money(r.day_price)}/天）` })) },
    { name:'guest_id', label:'房客', type:'select', required:true,
      options: guests.map(g => ({ value:g.id, label:`${g.name} ${g.phone || ''}` })) },
    { name:'check_in_date', label:'入住日期', type:'date', required:true },
    { name:'check_out_date', label:'退房日期', type:'date', required:true },
    { name:'day_price', label:'房价(/天)', type:'number', required:true, step:'0.01', money:true },
    { name:'deposit', label:'押金', type:'number', step:'0.01', money:true },
    { name:'remark', label:'备注', type:'textarea' }
  ], data, async (d, modal) => {
    if (d.check_out_date <= d.check_in_date){ alert('退房日期必须晚于入住日期'); return; }
    await api(id ? '/api/orders/' + id : '/api/orders', id ? 'PUT' : 'POST', d);
    modal.hide(); renderOrders();
  });
}

async function checkinOrder(id){
  if (!confirm('确认为该订单办理入住？')) return;
  await api(`/api/orders/${id}/checkin`, 'POST');
  renderOrders();
}

async function checkoutOrder(id){
  if (!confirm('确认为该订单办理退房？\n将自动生成房费账单，房间进入待清洁状态。')) return;
  await api(`/api/orders/${id}/checkout`, 'POST');
  alert('退房成功，账单已生成');
  renderOrders();
}

async function cancelOrder(id){
  if (!confirm('确定取消该预订？')) return;
  await api(`/api/orders/${id}/cancel`, 'POST');
  renderOrders();
}

async function delOrder(id){
  if (!confirm('确定删除该订单？')) return;
  try { await api('/api/orders/' + id, 'DELETE'); renderOrders(); }
  catch(e){ alert(e.message); }
}

