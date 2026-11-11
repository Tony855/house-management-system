'use strict';
/* ==================================================================
 *  9. 房间 / 房产管理
 * ================================================================== */
let roomFilter = { building_id:'', status:'', keyword:'' };

async function renderRooms(){
  const mode = curMode();
  const buildings = await api('/api/buildings');
  const qs = new URLSearchParams(
    Object.entries(roomFilter).filter(([, v]) => v !== '' && v !== null)
  ).toString();
  const rooms = await api('/api/rooms' + (qs ? '?' + qs : ''));

  const bOpts = buildings.map(b =>
    `<option value="${b.id}" ${String(roomFilter.building_id) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('');

  let statusOpts, head, body, addLabel;

  if (mode === 'rental'){
    statusOpts = [['vacant','空置'], ['rented','已出租'], ['maintenance','维修中']];
    addLabel = '新增房间';
    head = '<th>楼栋</th><th>房间号</th><th>楼层</th><th>面积</th><th>月租</th><th>押金</th><th>状态</th><th>当前租客</th><th>合同到期</th>' + (canAnyOp('room_add','room_edit','room_delete') ? '<th width="170">操作</th>' : '');
    body = rooms.map(r => `<tr>
      <td>${esc(r.building_name)}</td>
      <td><b>${esc(r.room_no)}</b></td>
      <td>${r.floor ?? '-'}</td>
      <td>${r.area ? r.area + '㎡' : '-'}</td>
      <td>${money(r.rent)}</td>
      <td>${money(r.deposit)}</td>
      <td>${statusBadge(r.status, 'rental')}</td>
      <td>${r.tenant_name ? esc(r.tenant_name) : '<span class="text-muted">-</span>'}</td>
      <td>${r.end_date || '-'}</td>
      <td>${canAnyOp('room_add','room_edit','room_delete') ? `
        ${canOp('room_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editRoom(${r.id})">编辑</button>` : ''}
        ${canOp('room_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delRoom(${r.id})">删除</button>` : ''}` : ''}</td></tr>`).join('');
  }
  else if (mode === 'hotel'){
    statusOpts = [['vacant','空闲'], ['rented','已入住'], ['booked','已预订'], ['cleaning','待清洁'], ['maintenance','维修中']];
    addLabel = '新增房间';
    head = '<th>楼栋</th><th>房间号</th><th>房型</th><th>楼层</th><th>日房价</th><th>状态</th><th>当前客人</th><th>离店日</th>' + (canAnyOp('room_add','room_edit','room_delete') ? '<th width="170">操作</th>' : '');
    body = rooms.map(r => `<tr>
      <td>${esc(r.building_name)}</td>
      <td><b>${esc(r.room_no)}</b></td>
      <td>${esc(r.room_type || '-')}</td>
      <td>${r.floor ?? '-'}</td>
      <td>${money(r.day_price)}</td>
      <td>${statusBadge(r.status, 'hotel')}</td>
      <td>${r.tenant_name ? esc(r.tenant_name) : '<span class="text-muted">-</span>'}</td>
      <td>${r.end_date || '-'}</td>
      <td>${canAnyOp('room_add','room_edit','room_delete') ? `
        ${canOp('room_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editRoom(${r.id})">编辑</button>` : ''}
        ${canOp('room_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delRoom(${r.id})">删除</button>` : ''}` : ''}</td></tr>`).join('');
  }
  else {
    statusOpts = [['vacant','空置'], ['rented','已入住'], ['maintenance','维修中']];
    addLabel = '新增房产';
    head = '<th>楼栋</th><th>房号</th><th>面积</th><th>状态</th><th>企业</th><th>电话</th><th>物业费/月</th><th>水价</th><th>电价</th><th>欠费</th>' + (canAnyOp('room_add','room_edit','room_delete') ? '<th width="170">操作</th>' : '');
    const allBills = await api('/api/bills');
    const oweMap = {};
    allBills.forEach(b => {
      if (b.source === 'property' || b.source === 'network'){
        oweMap[b.room_id] = (oweMap[b.room_id] || 0) + (b.amount - (b.paid_amount || 0));
      }
    });
    body = rooms.map(r => {
      const owe = oweMap[r.id] || 0;
      return `<tr>
        <td>${esc(r.building_name)}</td>
        <td><b>${esc(r.room_no)}</b></td>
        <td>${r.area ? r.area + '㎡' : '-'}</td>
        <td>${statusBadge(r.status, 'property')}</td>
        <td>${r.owner_name ? esc(r.owner_name) : '<span class="text-muted">未绑定</span>'}</td>
        <td>${esc(r.owner_phone || '-')}</td>
        <td>${money(r.property_fee)}</td>
        <td>${money(r.water_price)}/吨</td>
        <td>${money(r.elec_price)}/度</td>
        <td>${owe > 0 ? `<span class="text-danger fw-bold">${money(owe)}</span>` : '<span class="text-muted">-</span>'}</td>
        <td>${canAnyOp('room_add','room_edit','room_delete') ? `
          ${canOp('room_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editRoom(${r.id})">编辑</button>` : ''}
          ${canOp('room_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delRoom(${r.id})">删除</button>` : ''}` : ''}</td></tr>`;
    }).join('');
  }

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="roomFilter.building_id=this.value;renderRooms()">
          <option value="">全部楼栋</option>${bOpts}
        </select>
      </div>
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="roomFilter.status=this.value;renderRooms()">
          <option value="">全部状态</option>
          ${statusOpts.map(o => `<option value="${o[0]}" ${roomFilter.status === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}
        </select>
      </div>
      <div class="col-auto">
        <input class="form-control form-control-sm" placeholder="搜索房号，回车确认"
               value="${esc(roomFilter.keyword)}"
               onkeydown="if(event.key==='Enter'){roomFilter.keyword=this.value;renderRooms()}">
      </div>
      <div class="col-auto">
        ${canOp('room_add') ? `<button class="btn btn-sm btn-primary" onclick="editRoom()">+ ${addLabel}</button>` : ''}
      </div>
      <div class="col-auto text-muted small">共 ${rooms.length} 间</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="11" class="text-center text-muted py-4">暂无数据</td></tr>`}</tbody>
  </table></div></div>`;
}

async function editRoom(id, after, dorm){
  const mode = curMode();
  const [buildings, tenants] = await Promise.all([
    api('/api/buildings'),
    mode === 'property' ? api('/api/tenants') : Promise.resolve([])
  ]);
  if (!buildings.length){ alert('请先创建楼栋'); return; }

  let data = {
    status:'vacant', rent:0, deposit:0, day_price:0,
    property_fee:0,
    water_price: (DB.data.settings && DB.data.settings.water_price !== undefined)
      ? DB.data.settings.water_price : 4.5,
    elec_price: (DB.data.settings && DB.data.settings.elec_price !== undefined)
      ? DB.data.settings.elec_price : 1,
    owner_id:null, building_id: buildings[0].id
  };
  if (dorm) data.is_dorm = true;
  if (id){
    const rooms = await safeApi('/api/rooms');
    if (!rooms) return;
    data = rooms.find(r => r.id === id) || data;
  }

  const fields = [
    { name:'building_id', label:'所属楼栋', type:'select', required:true,
      options: buildings.map(b => ({ value:b.id, label:b.name })) },
    { name:'room_no', label: mode === 'property' ? '房号' : '房间号',
      required:true, placeholder:'如：101' },
    { name:'room_type', label:'房型', placeholder:'如：一居室 / 标准间' },
    { name:'floor', label:'楼层', type:'number' },
    { name:'area', label:'面积(㎡)', type:'number', step:'0.1' }
  ];

  if (mode === 'rental'){
    fields.push({ name:'rent', label:'月租金', type:'number', required:true, money:true });
    fields.push({ name:'deposit', label:'押金', type:'number', money:true });
    fields.push({ name:'water_price', label:'水费单价(/吨)', type:'number', step:'0.01', money:true });
    fields.push({ name:'elec_price', label:'电费单价(/度)', type:'number', step:'0.01', money:true });
    fields.push({ name:'status', label:'房间状态', type:'select', options:[
      { value:'vacant', label:'空置' }, { value:'rented', label:'已出租' },
      { value:'maintenance', label:'维修中' }] });
  } else if (mode === 'hotel'){
    fields.push({ name:'day_price', label:'日房价(/天)', type:'number', required:true, money:true });
    fields.push({ name:'status', label:'房间状态', type:'select', options:[
      { value:'vacant', label:'空闲' }, { value:'rented', label:'已入住' },
      { value:'booked', label:'已预订' }, { value:'cleaning', label:'待清洁' },
      { value:'maintenance', label:'维修中' }] });
  } else {
    fields.push({ name:'owner_id', label:'绑定企业', type:'select',
      options: tenants.map(t => ({ value:t.id, label:`${t.name} ${t.phone || ''}` })) });
    fields.push({ name:'property_fee', label:'物业费(/月)', type:'number', money:true });
    fields.push({ name:'water_price', label:'水费单价(/吨)', type:'number', step:'0.01', money:true });
    fields.push({ name:'elec_price', label:'电费单价(/度)', type:'number', step:'0.01', money:true });
    fields.push({ name:'is_dorm', label:'作为宿舍', type:'checkbox', hint:'勾选后该房间作为宿舍，可在宿舍管理中分配员工入住' });
    fields.push({ name:'capacity', label:'宿舍容量(人)', type:'number', hint:'0 表示不限制；仅作为宿舍时生效' });
    fields.push({ name:'status', label:'房屋状态', type:'select', options:[
      { value:'vacant', label:'空置' }, { value:'rented', label:'已入住' },
      { value:'maintenance', label:'维修中' }] });
  }
  fields.push({ name:'remark', label:'备注', type:'textarea' });

  const title = mode === 'property' ? (id ? '编辑房产' : '新增房产')
                                    : (id ? '编辑房间' : '新增房间');

  openForm(title, fields, data, async (d, modal) => {
    await api(id ? '/api/rooms/' + id : '/api/rooms', id ? 'PUT' : 'POST', d);
    modal.hide(); (typeof after === 'function' ? after : renderRooms)();
  });
}

async function delRoom(id){
  const mode = curMode();
  if (!confirm(mode === 'property' ? '确定删除该房产？' : '确定删除该房间？')) return;
  try { await api('/api/rooms/' + id, 'DELETE'); renderRooms(); }
  catch(e){ alert(e.message); }
}

/* ==================================================================
 * 10. 房态图
 * ================================================================== */
async function renderRoomMap(){
  const [buildings, rooms] = await Promise.all([api('/api/buildings'), api('/api/rooms')]);
  const mode = curMode();
  const legendKeys = ['vacant','booked','rented','cleaning','maintenance'];
  const legend = legendKeys.map(k =>
    `<span class="me-3"><span class="legend-dot" style="background:${STATUS_HEX[k]}"></span>
      ${STATUS_TEXT[k][mode] || STATUS_TEXT[k].hotel}</span>`).join('');

  let html = `<div class="card mb-3"><div class="card-body py-2 small">${legend}</div></div>`;

  buildings.forEach(b => {
    const rs = rooms.filter(r => r.building_id === b.id);
    if (!rs.length) return;
    html += `<h6 class="mt-3 mb-2 text-muted"><i class="bi bi-building"></i> ${esc(b.name)}
      <span class="badge bg-light text-dark">${rs.length} 间</span></h6><div class="row g-2">`;
    rs.forEach(r => {
      const color = STATUS_HEX[r.status] || '#6b7280';
      html += `<div class="col-6 col-md-4 col-lg-3 col-xl-2">
        <div class="card room-card border-${STATUS_COLOR[r.status] || 'secondary'}"
             onclick="roomMenu(${r.id})">
          <div class="card-body p-2 text-center">
            <div class="rno" style="color:${color}">${esc(r.room_no)}</div>
            <div class="small text-muted">${esc(r.room_type || '')}</div>
            <div class="mt-1">${statusBadge(r.status)}</div>
            <div class="small text-truncate mt-1" style="min-height:18px">
              ${r.tenant_name ? esc(r.tenant_name) : '<span class="text-muted">-</span>'}
            </div>
            <div class="small text-muted text-truncate">${r.end_date || ''}</div>
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  });

  $('#page').innerHTML = html || '<div class="text-muted">暂无房间数据</div>';
}

async function roomMenu(roomId){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  const r = rooms.find(x => x.id === roomId);
  if (!r) return;

  const items = [];
  const title = `${r.building_name} ${r.room_no}`;

  if (r.status === 'vacant'){
    if (canOp('order_add')) items.push({ label:'📝 新增预订', fn: () => editOrder(null, r.id) });
    if (canOp('room_edit')) items.push({ label:'🔧 标记维修', cls:'btn-outline-danger', fn: async () => {
      await api('/api/rooms/' + r.id, 'PUT', { status:'maintenance' }); renderRoomMap();
    }});
  }
  if (r.status === 'booked'){
    const orders = await safeApi('/api/orders?status=booked');
    if (!orders) return;
    const o = orders.find(o => o.room_id === r.id);
    if (o){
      if (canOp('order_status')){
      items.push({ label:'✅ 办理入住', cls:'btn-outline-success', fn: async () => {
        await api(`/api/orders/${o.id}/checkin`, 'POST'); renderRoomMap();
      }});
      items.push({ label:'❌ 取消预订', cls:'btn-outline-secondary', fn: async () => {
        if (!confirm('确定取消该预订？')) return;
        await api(`/api/orders/${o.id}/cancel`, 'POST'); renderRoomMap();
      }});
      }
    }
  }
  if (r.status === 'rented'){
    const orders = await safeApi('/api/orders?status=checked_in');
    if (!orders) return;
    const o = orders.find(o => o.room_id === r.id);
    if (o){
      if (canOp('order_status')) items.push({ label:'🚪 办理退房', cls:'btn-outline-warning', fn: async () => {
        if (!confirm('办理退房？将自动生成房费账单，房间进入待清洁状态。')) return;
        await api(`/api/orders/${o.id}/checkout`, 'POST'); renderRoomMap();
      }});
    }
  }
  if (r.status === 'cleaning'){
    if (canOp('room_edit')) items.push({ label:'✨ 清洁完成', cls:'btn-outline-success', fn: async () => {
      await api('/api/rooms/' + r.id, 'PUT', { status:'vacant' }); renderRoomMap();
    }});
  }
  if (r.status === 'maintenance'){
    if (canOp('room_edit')) items.push({ label:'🔨 结束维修', cls:'btn-outline-success', fn: async () => {
      await api('/api/rooms/' + r.id, 'PUT', { status:'vacant' }); renderRoomMap();
    }});
  }
  if (canOp('room_edit')) items.push({ label:'✏️ 编辑房间', cls:'btn-outline-secondary', fn: () => editRoom(r.id) });

  openActions(title, items);
}

