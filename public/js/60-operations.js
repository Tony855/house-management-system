'use strict';
/* ==================================================================
 * 15. 水电抄表
 * ================================================================== */
let meterFilter = { month:'', building_id:'' };

async function renderMeters(){
  const t = today();
  if (!meterFilter.month) meterFilter.month = t.slice(0, 7);

  const buildings = await api('/api/buildings');
  const qs = new URLSearchParams(
    Object.entries(meterFilter).filter(([, v]) => v)
  ).toString();
  const list = await api('/api/meters' + (qs ? '?' + qs : ''));

  const sumWater = list.reduce((s, m) => s + Number(m.water_fee || 0), 0);
  const sumElec  = list.reduce((s, m) => s + Number(m.elec_fee  || 0), 0);
  const sumWaterUsage = list.reduce((s, m) => s + Number(m.water_usage || 0), 0);
  const sumElecUsage  = list.reduce((s, m) => s + Number(m.elec_usage  || 0), 0);

  const bOpts = buildings.map(b =>
    `<option value="${b.id}" ${String(meterFilter.building_id) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('');

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <label class="col-form-label col-form-label-sm me-1">月份</label>
        <input type="month" class="form-control form-control-sm"
               value="${esc(meterFilter.month)}"
               onchange="meterFilter.month=this.value;renderMeters()" style="width:160px">
      </div>
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="meterFilter.building_id=this.value;renderMeters()">
          <option value="">全部楼栋</option>${bOpts}
        </select>
      </div>
      <div class="col-auto">
        ${canOp('meter_add') ? `<button class="btn btn-sm btn-primary" onclick="editMeter()">+ 新增抄表</button>` : ''}
        ${canOp('bill_add') ? `<button class="btn btn-sm btn-outline-primary" onclick="addMeterBill()">+ 手动新增账单</button>` : ''}
      </div>
      <div class="col-auto text-muted small">共 ${list.length} 条</div>
    </div>
  </div></div>

  <div class="row g-3 mb-3">
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">水费合计</div>
        <div class="num text-info">${money(sumWater)}</div>
        <div class="small text-muted">用量 ${sumWaterUsage} 吨</div>
      </div></div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">电费合计</div>
        <div class="num text-warning">${money(sumElec)}</div>
        <div class="small text-muted">用量 ${sumElecUsage} 度</div>
      </div></div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">已抄表户数</div>
        <div class="num text-primary">${list.length}</div>
        <div class="small text-muted">共 ${buildings.length} 栋</div>
      </div></div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">水电合计</div>
        <div class="num text-danger">${money(sumWater + sumElec)}</div>
        <div class="small text-muted">网费请在网络管理页查看</div>
      </div></div>
    </div>
  </div>

  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>月份</th><th>楼栋/房号</th><th>${personLabel()}</th>
      <th>水表(上→本)</th><th>用水</th><th>水费</th>
      <th>电表(上→本)</th><th>用电</th><th>电费</th>
      <th>合计</th>${canAnyOp('meter_add','meter_edit','meter_delete') ? '<th width="150">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(m => `<tr>
      <td><b>${esc(m.month)}</b></td>
      <td>${esc(m.building_name || '')} ${esc(m.room_no || '')}</td>
      <td>${esc(m.owner_name || '-')}</td>
      <td><small>${m.water_prev} → ${m.water_curr}</small></td>
      <td>${m.water_usage} 吨</td>
      <td>${money(m.water_fee)}</td>
      <td><small>${m.elec_prev} → ${m.elec_curr}</small></td>
      <td>${m.elec_usage} 度</td>
      <td>${money(m.elec_fee)}</td>
      <td><b class="text-danger">${money((m.water_fee||0)+(m.elec_fee||0))}</b></td>
      ${canAnyOp('meter_add','meter_edit','meter_delete') ? `<td>
        ${canOp('meter_edit') ? `<button class="btn btn-sm btn-outline-primary" onclick="editMeter(${m.id})">编辑</button>` : ''}
        ${canOp('meter_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delMeter(${m.id})">删除</button>` : ''}
      </td>` : ''}</tr>`).join('') || '<tr><td colspan="12" class="text-center text-muted py-4">暂无抄表记录</td></tr>'}
    </tbody></table></div></div>

  <div class="alert alert-info mt-3 small mb-0">
    <i class="bi bi-info-circle"></i>
    水费 = (本期水表 − 上期水表) × 房间水费单价；
    电费 = (本期电表 − 上期电表) × 房间电费单价。
    录入当月抄表后，在「账单收费」页点击「生成${curMode() === 'property' ? '物业' : '水电'}账单」即可${curMode() === 'property' ? '合并到物业费账单' : '生成水电费账单'}。
    网费独立计算，请见「网络管理」。
  </div>`;
}

/* 抄表页手动新增账单（维修费 / 其它维修） */
async function addMeterBill(){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  const scoped = billableRooms(rooms);
  if (!scoped.length){ alert(curMode() === 'property' ? '请先在房产管理中为房屋绑定企业' : '请先在合同管理中为房间办理出租'); return; }
  const t = today(); const ym = curMonth();
  openForm('手动新增账单', [
    { name:'bill_type', label:'账单类型', type:'select', required:true, options:[
      { value:'repair', label:'维修费' }, { value:'other', label:'其它维修' }] },
    { name:'room_id', label:'房间', type:'select', required:true,
      options: scoped.map(r => ({ value:r.id,
        label:`${r.building_name || ''} ${r.room_no}｜${r.owner_name || ''}` })) },
    { name:'period_start', label:'费用起始日', type:'date', required:true, default: ym + '-01' },
    { name:'period_end',   label:'费用截止日', type:'date', required:true,
      default: addDays(addMonths(ym + '-01', 1), -1) },
    { name:'due_date',     label:'应缴日期', type:'date', required:true, default: ym + '-10' },
    { name:'amount',       label:'金额', type:'number', required:true, step:'0.01', money:true },
    { name:'items', label:'明细清单', type:'items', hint:'维修费/其它维修可录入明细行，合计自动填入金额', cat:'util' },
    { name:'remark', label:'备注', type:'textarea' }
  ], { bill_type:'repair' }, async (d, modal) => {
    await api('/api/bills', 'POST', {
      source: d.bill_type, room_id: Number(d.room_id),
      period_start:d.period_start, period_end:d.period_end, due_date:d.due_date,
      amount:d.amount, remark:d.remark || '', items:d.items
    });
    modal.hide(); renderMeters();
  });
}

async function editMeter(id){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  const scoped = billableRooms(rooms);
  if (!scoped.length){ alert(curMode() === 'property' ? '请先在房产管理中为房屋绑定企业' : '请先在合同管理中为房间办理出租'); return; }

  const t = today();
  let data = { month: t.slice(0, 7), water_prev:0, water_curr:0, elec_prev:0, elec_curr:0 };

  if (id){
    const list = await api('/api/meters');
    const m = list.find(x => x.id === id);
    if (m) data = m;
  } else {
    data.room_id = scoped[0].id;
    const prev = (await api('/api/meters?room_id=' + scoped[0].id))
      .sort((a, b) => (b.month || '').localeCompare(a.month || ''))[0];
    if (prev){
      data.water_prev = prev.water_curr;
      data.elec_prev  = prev.elec_curr;
    }
  }

  const roomOpts = scoped.map(r => ({
    value: r.id,
    label: `${r.building_name || ''} ${r.room_no}｜${roomPerson(r) || '未命名'}｜水${money(r.water_price)}/吨 电${money(r.elec_price)}/度`
  }));

  openForm(id ? '编辑抄表记录' : '新增抄表记录', [
    { name:'room_id', label: curMode() === 'property' ? '房产' : '房间', type:'select', required:true, options: roomOpts },
    { name:'month', label:'抄表月份', type:'month', required:true },
    { name:'water_prev', label:'上期水表读数(吨)', type:'number', step:'0.01', required:true },
    { name:'water_curr', label:'本期水表读数(吨)', type:'number', step:'0.01', required:true },
    { name:'elec_prev',  label:'上期电表读数(度)', type:'number', step:'0.01', required:true },
    { name:'elec_curr',  label:'本期电表读数(度)', type:'number', step:'0.01', required:true },
    { name:'remark', label:'备注', type:'textarea' }
  ], data, async (d, modal) => {
    if (Number(d.water_curr) < Number(d.water_prev)){ alert('本期水表读数不能小于上期'); return; }
    if (Number(d.elec_curr)  < Number(d.elec_prev)) { alert('本期电表读数不能小于上期'); return; }
    await api(id ? '/api/meters/' + id : '/api/meters', id ? 'PUT' : 'POST', d);
    modal.hide(); renderMeters();
  });
}

async function delMeter(id){
  if (!confirm('确定删除该抄表记录？')) return;
  await api('/api/meters/' + id, 'DELETE');
  renderMeters();
}

/* ==================================================================
 * 16. 网络管理（物业模式）
 * ================================================================== */
let netFilter = { month:'', building_id:'' };

async function renderNetwork(){
  const t = today();
  if (!netFilter.month) netFilter.month = t.slice(0, 7);

  const buildings = await api('/api/buildings');
  const qs = new URLSearchParams(
    Object.entries(netFilter).filter(([, v]) => v)
  ).toString();
  const data = await api('/api/netfee' + (qs ? '?' + qs : ''));
  const list = data.list || [];

  /* 当月已生成的网费账单（用于每户「生成/删除账单」按钮） */
  const nBills = (await api('/api/bills?source=network'))
    .filter(b => b.period_start && String(b.period_start).startsWith(netFilter.month));
  const billByRoom = {};
  nBills.forEach(b => { billByRoom[b.room_id] = b; });

  const bOpts = buildings.map(b =>
    `<option value="${b.id}" ${String(netFilter.building_id) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('');

  const sum = data.summary || { sumFee:0, sumBandwidth:0, sumFull:0, count:0 };

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <label class="col-form-label col-form-label-sm me-1">月份</label>
        <input type="month" class="form-control form-control-sm"
               value="${esc(netFilter.month)}"
               onchange="netFilter.month=this.value;renderNetwork()" style="width:160px">
      </div>
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="netFilter.building_id=this.value;renderNetwork()">
          <option value="">全部楼栋</option>${bOpts}
        </select>
      </div>
      <div class="col-auto">
        ${canOp('bill_generate') ? `<button class="btn btn-sm btn-success" onclick="generateBills('network')">
          <i class="bi bi-magic"></i> 生成本月网费账单</button>` : ''}
      </div>
      <div class="col-auto">
        ${canOp('bill_add') ? `<button class="btn btn-sm btn-outline-primary" onclick="editNetBill()">
          <i class="bi bi-plus-lg"></i> 手动新增</button>` : ''}
      </div>
      <div class="col-auto text-muted small">共 ${list.length} 户</div>
    </div>
  </div></div>

  <div class="row g-3 mb-3">
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">本月网费合计（按天折算）</div>
        <div class="num text-primary">${money(sum.sumFee)}</div>
      </div></div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">满月网费合计</div>
        <div class="num text-secondary">${money(sum.sumFull)}</div>
      </div></div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">总带宽</div>
        <div class="num text-info">${sum.sumBandwidth} 兆</div>
      </div></div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-2">
        <div class="text-muted small">当月天数</div>
        <div class="num text-warning">${data.days_in_month || 30} 天</div>
      </div></div>
    </div>
  </div>

  <div class="card mb-3">
    <div class="card-header bg-white fw-bold d-flex align-items-center">
      <i class="bi bi-wifi text-primary me-1"></i> 宽带申请
      <span class="small text-muted ms-2">企业管理员提交报装 / 加兆 / 减兆申请，主管理员审批后自动执行</span>
      ${ME.level === 'company_admin' && canOp('netline_bandwidth')
        ? '<button class="btn btn-sm btn-primary ms-auto" onclick="addNetRequest()">+ 申请上报</button>' : ''}
    </div>
    <div class="card-body py-2" id="netReqBox"><div class="text-muted">加载中…</div></div>
  </div>

  <div class="card mb-3"><div class="card-header bg-white fw-bold">
    <i class="bi bi-ethernet text-primary"></i> 各房间网费明细（${esc(data.month)}）</div>
    <div class="table-responsive" style="max-height:520px"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>楼栋/房号</th><th>${personLabel()}</th><th>电话</th>
      <th>线路</th><th>月初带宽</th><th>当前带宽</th><th>每兆月租</th>
      <th>本月变更</th><th>本月网费</th>${canAnyOp('bill_add','bill_generate','bill_delete','netline_add','netline_edit','netline_bandwidth','netline_status') ? '<th width="300">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(r => {
      const bill = billByRoom[r.room_id];
      const billBtns = canOp('bill_delete') ? (bill
        ? `${bill.status === 'paid'
            ? '<span class="text-muted small" title="已收款账单不能更新">已收款</span>'
            : (canOp('bill_generate') ? `<button class="btn btn-sm btn-outline-primary" onclick="updateRoomNetBill(${r.room_id}, '${esc(netFilter.month)}')">更新账单</button>` : '')}
           <button class="btn btn-sm btn-outline-danger" onclick="delRoomNetBill(${bill.id})">删除账单</button>`
        : ((r.bandwidth || 0) <= 0
          ? '<span class="text-muted small">无带宽</span>'
          : (canOp('bill_generate') ? `<button class="btn btn-sm btn-outline-warning" onclick="genRoomNetBill(${r.room_id}, '${esc(netFilter.month)}')">生成账单</button>` : ''))) : '';
      const lines = r.lines || [];
      const activeCount = lines.filter(l => l.status === 'active').length;
      const lineRows = lines.map(l => {
        const segTxt = (l.segments && l.segments.length)
          ? `<span class="text-muted small">${l.segments.map(s => `${s.bandwidth}兆×${s.days}天`).join(' + ')}</span>`
          : '';
        const ops = !canAnyOp('netline_bandwidth','netline_edit','netline_status')
          ? ''
          : (l.status === 'active'
            ? `${canOp('netline_bandwidth') ? `<button class="btn btn-sm btn-outline-success" onclick="changeBandwidth(${r.room_id}, ${l.id}, 'add')">加兆</button>
               <button class="btn btn-sm btn-outline-danger"  onclick="changeBandwidth(${r.room_id}, ${l.id}, 'reduce')">减兆</button>` : ''}
               ${canOp('netline_edit') ? `<button class="btn btn-sm btn-outline-secondary" onclick="editNetLine(${l.id})">编辑</button>` : ''}
               ${canOp('netline_status') ? `<button class="btn btn-sm btn-outline-dark"    onclick="stopNetLine(${l.id})">停用</button>` : ''}`
            : `<span class="text-muted">已停用（${esc(l.stop_date || '-')}）</span>
               ${canOp('netline_status') ? `<button class="btn btn-sm btn-outline-success" onclick="startNetLine(${l.id})">重新启用</button>` : ''}`);
        return `<tr class="table-light">
          <td colspan="${canAnyOp('bill_add','bill_generate','bill_delete','netline_add','netline_edit','netline_bandwidth','netline_status') ? 10 : 9}" class="py-1">
            <div class="d-flex align-items-center gap-2 flex-wrap" style="padding-left:28px">
              <i class="bi bi-diagram-3 text-muted"></i>
              <b>${esc(l.line_name)}</b>
              <span class="bw-tag">${l.bandwidth} 兆</span>
              ${l.status === 'active'
                ? '<span class="badge bg-success">启用</span>'
                : '<span class="badge bg-secondary">停用</span>'}
              <small class="text-muted">开通 ${esc(l.start_date || '-')}${l.status === 'stopped' ? ' · 停用 ' + esc(l.stop_date || '-') : ''}</small>
              <span class="ms-auto d-flex align-items-center gap-2 flex-wrap">
                ${segTxt ? segTxt + ' ' : ''}${ops}
              </span>
            </div>
          </td></tr>`;
      }).join('');
      return `
      <tr class="align-middle">
        <td><b>${esc(r.building_name || '')} ${esc(r.room_no || '')}</b></td>
        <td>${esc(r.owner_name || '-')}</td>
        <td>${esc(r.owner_phone || '-')}</td>
        <td><span class="badge bg-light text-dark">${activeCount}/${lines.length} 条</span></td>
        <td><span class="bw-tag">${r.month_start_bandwidth} 兆</span></td>
        <td><span class="bw-tag">${r.bandwidth} 兆</span></td>
        <td><span class="text-muted" title="统一取本经营主体系统设置的网费单价">${money(r.price)}/兆</span></td>
        <td>${r.changes_in_month > 0
              ? `<span class="badge bg-warning text-dark">${r.changes_in_month} 次</span>`
              : '<span class="text-muted">-</span>'}</td>
        <td><b class="text-primary">${money(r.month_fee)}</b>
            <div class="text-muted" style="font-size:12px">
              （满月 ${money(r.full_month_fee)}）
            </div></td>
        <td>
          ${canOp('netline_add') ? `<button class="btn btn-sm btn-outline-primary" onclick="addNetLine(${r.room_id}, ${r.bandwidth || 0})">+ 线路</button>` : ''}
          <button class="btn btn-sm btn-outline-info"    onclick="showNetSegments(${r.room_id}, '${esc(data.month)}')">明细</button>
          <button class="btn btn-sm btn-outline-secondary" onclick="showNetHistory(${r.room_id})">历史</button>
          ${billBtns}
        </td>
      </tr>${lineRows}`;
    }).join('') || `<tr><td colspan="${canAnyOp('bill_add','bill_generate','bill_delete','netline_add','netline_edit','netline_bandwidth','netline_status') ? 10 : 9}" class="text-center text-muted py-4">暂无数据（${curMode() === 'property' ? '请先在房产管理为房屋绑定企业' : '请先在合同管理为房间办理出租'}）</td></tr>`}
    </tbody></table></div>
  </div>

  <div class="card">
    <div class="card-header bg-white fw-bold">
      <i class="bi bi-clock-history"></i> 最近带宽变更记录</div>
    <div class="table-responsive" style="max-height:280px" id="netChangesBox">
      <div class="text-muted p-3">加载中…</div>
    </div>
  </div>`;

  /* 加载最近变更 */
  const changeQs = new URLSearchParams();
  if (netFilter.building_id) changeQs.set('building_id', netFilter.building_id);
  const changes = await api('/api/netChanges' + (changeQs.toString() ? '?' + changeQs.toString() : ''));
  const box = document.getElementById('netChangesBox');
  if (box){
    box.innerHTML = `<table class="table table-hover mb-0">
      <thead class="table-light"><tr>
        <th>日期</th><th>楼栋/房号</th><th>${personLabel()}</th><th>类型</th>
        <th>线路</th><th>带宽变更</th><th>备注</th>
      </tr></thead>
      <tbody>${changes.slice(0, 30).map(c => {
        const typeLabel = c.change_type === 'add'
          ? '<span class="badge bg-success">加兆</span>'
          : '<span class="badge bg-danger">减兆</span>';
        const delta = c.delta >= 0 ? `+${c.delta}` : c.delta;
        return `<tr>
          <td>${esc(c.change_date)}</td>
          <td>${esc(c.building_name || '')} ${esc(c.room_no || '')}</td>
          <td>${esc(c.owner_name || '-')}</td>
          <td>${typeLabel}</td>
          <td><small>${esc(c.line_name || '默认线路')}</small></td>
          <td><span class="bw-tag">${c.old_bandwidth} → ${c.new_bandwidth} 兆</span>
              <small class="text-muted">（${delta}）</small></td>
          <td><small>${esc(c.remark || '-')}</small></td>
        </tr>`;
      }).join('') || '<tr><td colspan="7" class="text-center text-muted py-4">暂无变更记录</td></tr>'}
      </tbody></table>`;
  }

  /* 宽带申请（上报）列表 */
  renderNetRequests();
}

const NET_REQ_TYPE = {
  install: '<span class="badge bg-primary">报装</span>',
  add:     '<span class="badge bg-success">加兆</span>',
  reduce:  '<span class="badge bg-danger">减兆</span>'
};
const NET_REQ_STATUS = {
  pending:  '<span class="badge bg-warning text-dark">待处理</span>',
  done:     '<span class="badge bg-success">已执行</span>',
  rejected: '<span class="badge bg-secondary">已驳回</span>'
};
async function renderNetRequests(){
  const box = document.getElementById('netReqBox');
  if (!box) return;
  let list = [];
  try { list = await api('/api/netRequests'); } catch(e){ box.innerHTML = '<div class="text-muted">' + esc(e.message) + '</div>'; return; }
  const canAudit = ME.level === 'admin';
  box.innerHTML = `<div class="table-responsive" style="max-height:260px"><table class="table table-sm table-hover mb-0">
    <thead class="table-light"><tr>
      <th>提交时间</th><th>类型</th><th>楼栋/房号</th><th>企业</th>
      <th>申请内容</th><th>说明</th><th>状态</th>${canAudit ? '<th width="180">处理</th>' : ''}
    </tr></thead>
    <tbody>${list.map(q => {
      const content = q.type === 'install'
        ? `<span class="bw-tag">报装 ${q.bandwidth} 兆</span>`
        : `<span class="bw-tag">${esc(q.line_name || '线路')} ${q.type === 'add' ? '+' : '-'}${q.delta} 兆</span>`;
      const audit = canAudit && q.status === 'pending'
        ? `<button class="btn btn-sm btn-outline-success me-1" onclick="handleNetRequest(${q.id}, 'approve')">通过并执行</button>
           <button class="btn btn-sm btn-outline-secondary" onclick="handleNetRequest(${q.id}, 'reject')">驳回</button>`
        : (canAudit && q.handled_by ? `<small class="text-muted">${esc(q.handled_by)}<br>${esc(q.handle_note || '')}</small>` : '');
      return `<tr>
        <td><small>${esc((q.created_at || '').slice(0, 16))}</small></td>
        <td>${NET_REQ_TYPE[q.type] || q.type}</td>
        <td>${esc(q.building_name || '')} ${esc(q.room_no || '')}</td>
        <td>${esc(q.company_name || '-')}</td>
        <td>${content}</td>
        <td><small>${esc(q.reason || '-')}</small></td>
        <td>${NET_REQ_STATUS[q.status] || q.status}</td>
        ${canAudit ? `<td>${audit}</td>` : ''}
      </tr>`;
    }).join('') || '<tr><td colspan="' + (canAudit ? 8 : 7) + '" class="text-center text-muted py-3">暂无申请</td></tr>'}
    </tbody></table></div>`;
}

/* 企业管理员：提交宽带申请（上报） */
async function addNetRequest(){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  if (!rooms.length){ alert('暂无本企业房产，请先由物业主管理员绑定'); return; }
  const netLines = await safeApi('/api/netLines');
  if (!netLines) return;
  const roomOpts = rooms.map(r => ({ value: r.id,
    label: `${r.building_name || ''} ${r.room_no}｜${r.owner_name || ''}` }));
  openForm('上报宽带申请', [
    { name:'type', label:'申请类型', type:'select', required:true,
      options: [
        { value:'install', label:'宽带报装（新开线路）' },
        { value:'add',     label:'加兆（带宽增加）' },
        { value:'reduce',  label:'减兆（带宽减少）' }
      ] },
    { name:'room_id', label:'房间', type:'select', required:true, options: roomOpts },
    { name:'line_id', label:'宽带线路', type:'select', options: [] },
    { name:'bandwidth', label:'报装带宽（兆）', type:'number', step:'1',
      hint:'报装时填写目标带宽' },
    { name:'delta', label:'增减兆数', type:'number', step:'1', hint:'加兆/减兆时填写增减数值' },
    { name:'reason', label:'申请说明', type:'textarea', placeholder:'如：办公扩编需要提速' }
  ], {}, async (d, modal) => {
    await api('/api/netRequests', 'POST', {
      type: d.type, room_id: Number(d.room_id),
      line_id: d.line_id ? Number(d.line_id) : null,
      bandwidth: d.bandwidth !== null && d.bandwidth !== undefined ? Number(d.bandwidth) : null,
      delta: d.delta !== null && d.delta !== undefined ? Number(d.delta) : null,
      reason: d.reason || ''
    });
    modal.hide(); renderNetwork();
  }, (el) => {
    const $ = n => el.querySelector(`[name="${n}"]`);
    const typeSel = $('type'), roomSel = $('room_id'), lineSel = $('line_id'),
          bwRow = $('bandwidth').closest('.mb-3'), deltaRow = $('delta').closest('.mb-3'),
          lineRow = lineSel.closest('.mb-3');
    const lineOpts = roomId => {
      const ls = netLines.filter(l => l.room_id === Number(roomId) && l.status === 'active');
      lineSel.innerHTML = '<option value="">-- 请选择线路 --</option>'
        + ls.map(l => `<option value="${l.id}">${esc(l.line_name)}（${l.bandwidth} 兆）</option>`).join('');
      lineSel.disabled = !ls.length;
    };
    const sync = () => {
      const t = typeSel.value;
      bwRow.style.display = t === 'install' ? '' : 'none';
      deltaRow.style.display = (t === 'add' || t === 'reduce') ? '' : 'none';
      lineRow.style.display = (t === 'add' || t === 'reduce') ? '' : 'none';
      if (t !== 'install') lineOpts(roomSel.value);
    };
    typeSel.addEventListener('change', sync);
    roomSel.addEventListener('change', () => { if (typeSel.value !== 'install') lineOpts(roomSel.value); });
    sync();
  });
}

/* 主管理员：审批申请（通过并执行 / 驳回） */
async function handleNetRequest(id, action){
  const note = action === 'approve'
    ? (prompt('处理说明（可选）：') || '')
    : (prompt('驳回原因（必填）：') || '');
  if (action === 'reject' && !note){ alert('请填写驳回原因'); return; }
  if (action === 'approve' && !confirm('确认通过该申请并立即执行线路变更？')) return;
  try {
    const r = await api('/api/netRequests/' + id, 'PUT', { action, handle_note: note });
    alert(action === 'approve' ? '已通过并执行' : '已驳回');
    renderNetwork();
  } catch(e){ alert(e.message); }
}

/* 手动新增一条网费账单（租房按履行中合同、物业按企业绑定） */
async function editNetBill(){
  const mode = curMode();
  const ym = netFilter.month || today().slice(0, 7);
  const pStart = ym + '-01';
  const pEnd = addDays(addMonths(pStart, 1), -1);

  const roomsAll = await safeApi('/api/rooms');
  if (!roomsAll) return;
  const roomById = {};
  roomsAll.forEach(r => { roomById[r.id] = r; });

  /* 带宽默认取该房所有启用线路的总带宽 */
  const netLines = await safeApi('/api/netLines');
  if (!netLines) return;
  const bwByRoom = {};
  netLines.filter(l => l.status === 'active').forEach(l => {
    bwByRoom[l.room_id] = (bwByRoom[l.room_id] || 0) + (Number(l.bandwidth) || 0);
  });

  let options, resolveTenant, firstBw;
  if (mode === 'property'){
    const owned = roomsAll.filter(r => r.owner_id);
    if (!owned.length){ alert('请先在房产管理为房屋绑定企业'); return; }
    options = owned.map(r => ({ value:r.id,
      label:`${r.building_name || ''} ${r.room_no}｜${r.owner_name || ''}` }));
    resolveTenant = roomId => (roomById[roomId] || {}).owner_id;
    firstBw = bwByRoom[owned[0].id] || 0;
  } else {
    const contracts = await safeApi('/api/contracts?status=active');
    if (!contracts) return;
    if (!contracts.length){ alert('没有履行中的合同，请先在合同管理为房间办理出租'); return; }
    const tenantByRoom = {};
    contracts.forEach(c => { tenantByRoom[c.room_id] = c.tenant_id; });
    options = contracts.map(c => ({ value:c.room_id,
      label:`${c.building_name || ''} ${c.room_no}｜${c.tenant_name || ''}` }));
    resolveTenant = roomId => tenantByRoom[roomId];
    firstBw = bwByRoom[contracts[0].room_id] || 0;
  }

  /* 单价取本经营主体「系统设置」，按 org 隔离 */
  const priceCny = Number(DB.data.settings.net_price_per_mb) || 0;

  openForm('手动新增账单', [
    { name:'bill_type', label:'账单类型', type:'select', required:true, options:[
      { value:'network', label:'网费' },
      { value:'net_repair', label:'网维修费' },
      { value:'install',    label:'设备安装费' }] },
    { name:'room_id', label:'房间', type:'select', required:true, options },
    { name:'net_bandwidth', label:'带宽（兆）', type:'number', required:true, step:'1', default:Number(firstBw) || 0 },
    { name:'net_price', label:'每兆月租单价', type:'number', step:'0.0001', money:true, readonly:true,
      default:priceCny, hint:'取本经营主体「系统设置」的网费单价，如需调整请到系统设置修改' },
    { name:'period_start', label:'费用起始日', type:'date', required:true, default:pStart },
    { name:'period_end',   label:'费用截止日', type:'date', required:true, default:pEnd },
    { name:'due_date',     label:'应缴日期', type:'date', required:true, default:ym + '-10' },
    { name:'amount',       label:'金额', type:'number', required:true, step:'0.01', money:true },
    { name:'items', label:'明细清单', type:'items', hint:'网维修费/设备安装费可录入明细行，合计自动填入金额', cat:'net' },
    { name:'remark', label:'备注', type:'textarea' }
  ], { bill_type:'network' }, async (d, modal) => {
    await api('/api/bills', 'POST', {
      source:d.bill_type, room_id:Number(d.room_id), tenant_id:resolveTenant(Number(d.room_id)) || null,
      period_start:d.period_start, period_end:d.period_end, due_date:d.due_date,
      amount:d.amount, remark:d.remark, items:d.items
    });
    modal.hide(); renderNetwork();
  }, (el) => {
    const $ = n => el.querySelector(`[name="${n}"]`);
    const typeSel = $('bill_type'), roomSel = $('room_id'), bwInput = $('net_bandwidth'),
          priceRow = $('net_price').closest('.mb-3'), bwRow = $('net_bandwidth').closest('.mb-3'),
          amtLabel = $('amount').closest('.mb-3').querySelector('.form-label'),
          ps = $('period_start'), pe = $('period_end'), amt = $('amount'),
          itemWrap = el.querySelector('.item-wrap');
    const recalc = () => {
      const bw = Number(bwInput.value) || 0;
      const s = ps.value, e = pe.value;
      const days = (s && e) ? ((new Date(e + 'T00:00:00') - new Date(s + 'T00:00:00')) / 86400000) + 1 : 0;
      const dim = s ? new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0).getDate() : 30;
      const amountCny = bw * priceCny * (days > 0 ? days / dim : 0);
      amt.value = toDisplayMoney(amountCny);
    };
    const sync = () => {
      const isNet = typeSel.value === 'network';
      bwRow.style.display = isNet ? '' : 'none';
      priceRow.style.display = isNet ? '' : 'none';
      if (itemWrap) itemWrap.style.display = isNet ? 'none' : '';
      amtLabel.innerHTML = (isNet ? '金额' : '金额') + ' <span class="text-danger">*</span>';
      if (isNet){ amt.readOnly = false; recalc(); }
    };
    typeSel.addEventListener('change', sync);
    roomSel.addEventListener('change', () => {
      const r = roomById[Number(roomSel.value)];
      if (r){ bwInput.value = bwByRoom[r.id] || 0; recalc(); }
    });
    bwInput.addEventListener('input', recalc);
    ps.addEventListener('change', recalc);
    pe.addEventListener('change', recalc);
    sync();
  });
}

/* 单户网费账单：生成 / 删除 */
async function genRoomNetBill(roomId, month){
  if (!confirm(`为该房产生成 ${month} 网费账单？\n（若当月已有网费账单将跳过）`)) return;
  try {
    const r = await api('/api/bills/generate', 'POST', { kind:'network', room_id: roomId });
    const extra = (r.detail && r.detail.length)
      ? '\n\n跳过原因：\n' + r.detail.map(d => '· ' + d.room + ' — ' + d.reason).join('\n') : '';
    alert(r.msg + extra);
    renderNetwork();
  } catch(e){ alert(e.message); }
}

async function updateRoomNetBill(roomId, month){
  if (!confirm(`按当前带宽/单价重算该房间 ${month} 网费账单？\n（未收款账单会更新金额与明细，账单 ID 保留）`)) return;
  try {
    const r = await api('/api/bills/update-network', 'POST', { room_id: roomId });
    alert(r.bill_id
      ? `已更新账单 #${r.bill_id}：金额由 ${money(r.old_amount)} 重算为 ${money(r.new_amount)}`
      : r.msg);
    renderNetwork();
  } catch(e){ alert(e.message); }
}

async function delRoomNetBill(billId){
  if (!confirm('确定删除该网费账单？')) return;
  try { await api('/api/bills/' + billId, 'DELETE'); renderNetwork(); }
  catch(e){ alert(e.message); }
}

/* 宽带线路：加兆 / 减兆（针对具体线路） */
async function changeBandwidth(roomId, lineId, kind){
  const lines = await safeApi('/api/netLines?room_id=' + roomId);
  if (!lines) return;
  const line = lines.find(x => x.id === Number(lineId));
  if (!line){ alert('宽带线路不存在'); return; }

  const isAdd = kind === 'add';
  const title = `${isAdd ? '加兆' : '减兆'} - ${esc(line.line_name)}`;
  const curBw = Number(line.bandwidth) || 0;

  openForm(title, [
    { name:'new_bandwidth', label:'新带宽(兆)', type:'number', required:true, step:'1',
      default: isAdd ? curBw + 50 : Math.max(0, curBw - 50),
      hint: `当前带宽 ${curBw} 兆，单价统一取本经营主体系统设置。` },
    { name:'change_date', label:'生效日期', type:'date', required:true, default: today() },
    { name:'remark', label:'备注', type:'textarea',
      default: isAdd ? `加兆 ${curBw} → 新带宽` : `减兆 ${curBw} → 新带宽` }
  ], {}, async (d, modal) => {
    const nb = Number(d.new_bandwidth);
    if (!Number.isFinite(nb) || nb < 0){ alert('请填写有效的带宽兆数'); return; }
    if (isAdd && nb <= curBw){ alert('加兆后的带宽应大于当前带宽'); return; }
    if (!isAdd && nb >= curBw){ alert('减兆后的带宽应小于当前带宽'); return; }
    await api('/api/netChanges', 'POST', {
      room_id: roomId, line_id: line.id,
      new_bandwidth: nb,
      change_date: d.change_date,
      remark: d.remark || ''
    });
    modal.hide();
    renderNetwork();
  });
}

/* 添加一条宽带线路 */
async function addNetLine(roomId, totalBw){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  const r = rooms.find(x => x.id === roomId);
  if (!r) return;
  openForm(`添加线路 - ${esc(r.building_name || '')} ${esc(r.room_no || '')}`, [
    { name:'line_name', label:'线路名称', required:true, default:'线路' + (Number(totalBw) > 0 ? '' : ''),
      placeholder:'如：主宽带 / 第二条 / 备用线路' },
    { name:'bandwidth', label:'带宽(兆)', type:'number', required:true, step:'1', default:50,
      hint:`该房当前启用线路总带宽 ${totalBw} 兆。` },
    { name:'start_date', label:'开通日期', type:'date', required:true, default: today() },
    { name:'remark', label:'备注', type:'textarea' }
  ], {}, async (d, modal) => {
    const bw = Number(d.bandwidth);
    if (!Number.isFinite(bw) || bw <= 0){ alert('请填写有效的带宽兆数'); return; }
    await api('/api/netLines', 'POST', { room_id: roomId, line_name:d.line_name,
      bandwidth:bw, start_date:d.start_date, remark:d.remark || '' });
    modal.hide(); renderNetwork();
  });
}

/* 编辑线路名称/备注 */
async function editNetLine(lineId){
  const lines = await safeApi('/api/netLines');
  if (!lines) return;
  const line = lines.find(x => x.id === Number(lineId));
  if (!line){ alert('线路不存在'); return; }
  openForm(`编辑线路 - ${esc(line.line_name)}`, [
    { name:'line_name', label:'线路名称', required:true, default:line.line_name },
    { name:'remark', label:'备注', type:'textarea', default:line.remark }
  ], {}, async (d, modal) => {
    await api('/api/netLines/' + line.id, 'PUT', d);
    modal.hide(); renderNetwork();
  });
}

/* 停用 / 重新启用线路 */
async function stopNetLine(lineId){
  if (!confirm('确定停用该线路？停用日起不再计费，历史记录保留。')) return;
  try { await api('/api/netLines/' + lineId + '/stop', 'POST', { stop_date: today() }); renderNetwork(); }
  catch(e){ alert(e.message); }
}
async function startNetLine(lineId){
  if (!confirm('确定重新启用该线路？将从今天起恢复计费。')) return;
  try { await api('/api/netLines/' + lineId + '/start', 'POST', { start_date: today() }); renderNetwork(); }
  catch(e){ alert(e.message); }
}

async function showNetSegments(roomId, month){
  const data = await safeApi(`/api/netfee?month=${encodeURIComponent(month)}`);
  if (!data) return;
  const r = (data.list || []).find(x => x.room_id === roomId);
  if (!r){ alert('未找到该房间的网费数据'); return; }

  const lines = r.lines || [];
  const linesHtml = lines.map(l => {
    const segHtml = (l.segments || []).map(s => `
      <div class="seg-row">
        <div>
          <b>${s.start} ~ ${s.end}</b>
          <span class="text-muted small">（${s.days} 天）</span>
        </div>
        <div class="text-end">
          <span class="bw-tag">${s.bandwidth} 兆</span>
          <small class="text-muted">× ${money(s.price)}/兆 × ${s.days}/${r.days_in_month}</small>
          <b class="ms-2 text-primary">${money(s.fee)}</b>
        </div>
      </div>`).join('') || '<div class="text-muted small">本月无计费分段</div>';
    return `<div class="border rounded p-2 mb-2">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <span><i class="bi bi-diagram-3 text-muted me-1"></i><b>${esc(l.line_name)}</b>
          <span class="bw-tag ms-1">${l.bandwidth} 兆</span>
          ${l.status === 'active' ? '<span class="badge bg-success">启用</span>' : '<span class="badge bg-secondary">停用</span>'}
        </span>
        <span class="text-primary fw-bold">${money(l.total)}</span>
      </div>
      ${segHtml}
    </div>`;
  }).join('') || '<div class="text-muted">该房间暂无宽带线路</div>';

  openInfo(`网费分段明细 - ${r.building_name} ${r.room_no}（${month}）`, `
    <div class="alert alert-info small mb-3">
      <i class="bi bi-calculator"></i>
      计算公式：<b>带宽兆数 × 每兆月租 × 段天数 ÷ 当月天数</b>，单价统一取本经营主体设置<br>
      当月总天数：${r.days_in_month} 天
    </div>
    ${linesHtml}
    <hr>
    <div class="d-flex justify-content-between">
      <span class="fw-bold">本月网费合计</span>
      <span class="fw-bold text-primary fs-5">${money(r.month_fee)}</span>
    </div>
  `, 'modal-lg');
}

async function showNetHistory(roomId){
  const changes = await api('/api/netChanges?room_id=' + roomId);
  if (!changes.length){
    openInfo('带宽变更历史', '<div class="text-muted">该房间暂无变更记录。</div>');
    return;
  }
  const html = `<div class="table-responsive"><table class="table table-sm mb-0">
    <thead class="table-light"><tr>
      <th>日期</th><th>线路</th><th>类型</th><th>带宽变更</th><th>备注</th></tr></thead>
    <tbody>${changes.map(c => {
      const t = c.change_type === 'add' ? '<span class="badge bg-success">加兆</span>'
              : '<span class="badge bg-danger">减兆</span>';
      const d = c.delta >= 0 ? `+${c.delta}` : c.delta;
      return `<tr>
        <td>${esc(c.change_date)}</td>
        <td><small>${esc(c.line_name || '默认线路')}</small></td>
        <td>${t}</td>
        <td><span class="bw-tag">${c.old_bandwidth} → ${c.new_bandwidth} 兆</span>
            <small class="text-muted">（${d}）</small></td>
        <td><small>${esc(c.remark || '-')}</small></td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
  openInfo('带宽变更历史', html, 'modal-lg');
}

/* ==================================================================
 * 17. 报修管理
 * ================================================================== */
let repairFilter = '';

async function renderRepairs(){
  const qs = repairFilter ? '?status=' + repairFilter : '';
  const list = await api('/api/repairs' + qs);

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="repairFilter=this.value;renderRepairs()">
          <option value="">全部报修</option>
          <option value="pending"    ${repairFilter === 'pending' ? 'selected' : ''}>待处理</option>
          <option value="processing" ${repairFilter === 'processing' ? 'selected' : ''}>处理中</option>
          <option value="done"       ${repairFilter === 'done' ? 'selected' : ''}>已完成</option>
        </select>
      </div>
      <div class="col-auto">${canOp('repair_add') ? `<button class="btn btn-sm btn-primary" onclick="editRepair()">+ 新增报修</button>` : ''}</div>
      <div class="col-auto text-muted small">共 ${list.length} 条</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>楼栋/房间</th><th>报修人</th><th>标题</th><th>问题描述</th>
      <th>状态</th><th>处理人</th><th>处理说明</th><th>报修时间</th>${canAnyOp('repair_add','repair_handle','repair_delete') ? '<th width="170">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(r => `<tr>
      <td><b>${esc(r.building_name || '')} ${esc(r.room_no || '-')}</b></td>
      <td>${esc(r.tenant_name || '-')}</td>
      <td>${esc(r.title)}</td>
      <td><small>${esc(r.content || '-')}</small></td>
      <td>${repairBadge(r.status)}</td>
      <td>${esc(r.handler || '-')}</td>
      <td><small>${esc(r.handle_note || '-')}</small></td>
      <td><small>${esc(r.created_at || '-')}</small></td>
      ${canAnyOp('repair_add','repair_handle','repair_delete') ? `<td>
        ${r.status !== 'done' && canOp('repair_handle')
          ? `<button class="btn btn-sm btn-outline-success" onclick="handleRepair(${r.id})">处理</button>` : ''}
        ${canOp('repair_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delRepair(${r.id})">删除</button>` : ''}
      </td>` : ''}</tr>`).join('') || '<tr><td colspan="9" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

async function editRepair(){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  if (!rooms.length){ alert(ME.level === 'company_admin' ? '暂无本企业房产，请先由物业主管理员绑定' : '请先创建房间'); return; }
  if (ME.level === 'company_admin'){
    /* 企业管理员：报修管理作为统一申请入口（网络维修 / 水电维修 / 其它维修） */
    openForm('报修申请', [
      { name:'room_id', label:'房产', type:'select', required:true,
        options: rooms.map(r => ({ value:r.id, label:`${r.building_name || ''} ${r.room_no}｜${r.owner_name || ''}` })) },
      { name:'type', label:'维修类型', type:'select', required:true, options:[
        { value:'网络维修', label:'网络维修' }, { value:'水电维修', label:'水电维修' },
        { value:'其它维修', label:'其它维修' }] },
      { name:'content', label:'问题描述', type:'textarea', required:true,
        placeholder:'如：办公室断网 / 卫生间漏水 / 门锁损坏' }
    ], { room_id: rooms[0].id, type:'网络维修' }, async (d, modal) => {
      await api('/api/repairs', 'POST', {
        room_id: Number(d.room_id), title: d.type, content: d.content || ''
      });
      modal.hide(); renderRepairs();
    });
    return;
  }
  openForm('新增报修', [
    { name:'room_id', label:'报修房间', type:'select', required:true,
      options: rooms.map(r => ({ value:r.id, label:`${r.building_name || ''} ${r.room_no}` })) },
    { name:'title', label:'报修标题', required:true, placeholder:'如：空调不制冷' },
    { name:'content', label:'问题描述', type:'textarea' }
  ], { room_id: rooms[0].id }, async (d, modal) => {
    await api('/api/repairs', 'POST', d);
    modal.hide(); renderRepairs();
  });
}

async function handleRepair(id){
  openForm('处理报修', [
    { name:'status', label:'处理状态', type:'select', options:[
      { value:'processing', label:'处理中' }, { value:'done', label:'已完成' }] },
    { name:'handler', label:'处理人', default: ME.name },
    { name:'handle_note', label:'处理说明', type:'textarea' }
  ], { status:'done', handler: ME.name }, async (d, modal) => {
    await api('/api/repairs/' + id, 'PUT', d);
    modal.hide(); renderRepairs();
  });
}

async function delRepair(id){
  if (!confirm('确定删除该报修记录？')) return;
  await api('/api/repairs/' + id, 'DELETE');
  renderRepairs();
}

/* ==================================================================
 * 18. 投诉建议
 * ================================================================== */
let complaintFilter = { status:'', type:'' };

async function renderComplaints(){
  const qs = new URLSearchParams(
    Object.entries(complaintFilter).filter(([, v]) => v)
  ).toString();
  const list = await api('/api/complaints' + (qs ? '?' + qs : ''));
  const pending = list.filter(c => c.status !== 'done').length;

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <select class="form-select form-select-sm"
                onchange="complaintFilter.status=this.value;renderComplaints()">
          <option value="">全部状态</option>
          <option value="pending"    ${complaintFilter.status === 'pending' ? 'selected' : ''}>待处理</option>
          <option value="processing" ${complaintFilter.status === 'processing' ? 'selected' : ''}>处理中</option>
          <option value="done"       ${complaintFilter.status === 'done' ? 'selected' : ''}>已办结</option>
        </select>
      </div>
      <div class="col-auto">
        <select class="form-select form-select-sm"
                onchange="complaintFilter.type=this.value;renderComplaints()">
          <option value="">全部类型</option>
          <option value="投诉" ${complaintFilter.type === '投诉' ? 'selected' : ''}>投诉</option>
          <option value="建议" ${complaintFilter.type === '建议' ? 'selected' : ''}>建议</option>
          <option value="咨询" ${complaintFilter.type === '咨询' ? 'selected' : ''}>咨询</option>
          <option value="其他" ${complaintFilter.type === '其他' ? 'selected' : ''}>其他</option>
        </select>
      </div>
      <div class="col-auto">
        ${canOp('complaint_add') ? `<button class="btn btn-sm btn-primary" onclick="editComplaint()">+ 登记投诉/建议</button>` : ''}
      </div>
      <div class="col-auto text-muted small">
        共 ${list.length} 条 · 未办结 <span class="text-danger fw-bold">${pending}</span>
      </div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>楼栋/房号</th><th>企业</th><th>电话</th><th>类型</th>
      <th>标题</th><th>内容</th><th>状态</th><th>处理人</th><th>处理说明</th><th>时间</th>${canAnyOp('complaint_add','complaint_handle','complaint_delete') ? '<th width="150">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(c => `<tr>
      <td><b>${esc(c.building_name || '')} ${esc(c.room_no || '-')}</b></td>
      <td>${esc(c.owner_name || '-')}</td>
      <td>${esc(c.owner_phone || '-')}</td>
      <td><span class="badge bg-light text-dark border">${esc(c.type)}</span></td>
      <td>${esc(c.title)}</td>
      <td><small>${esc(c.content || '-')}</small></td>
      <td>${complaintBadge(c.status)}</td>
      <td>${esc(c.handler || '-')}</td>
      <td><small>${esc(c.handle_note || '-')}</small></td>
      <td><small>${esc(c.created_at || '-')}</small></td>
      ${canAnyOp('complaint_add','complaint_handle','complaint_delete') ? `<td>
        ${c.status !== 'done' && canOp('complaint_handle')
          ? `<button class="btn btn-sm btn-outline-success" onclick="handleComplaint(${c.id})">处理</button>` : ''}
        ${canOp('complaint_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delComplaint(${c.id})">删除</button>` : ''}
      </td>` : ''}</tr>`).join('') || '<tr><td colspan="11" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

async function editComplaint(){
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  const owned = rooms.filter(r => r.owner_id);
  if (!owned.length){ alert('请先在房产管理中为房屋绑定企业'); return; }

  const opts = owned.map(r => ({
    value: r.id,
    label: `${r.building_name || ''} ${r.room_no}｜${r.owner_name || ''}`
  }));

  openForm('登记投诉 / 建议', [
    { name:'room_id', label:'房产', type:'select', required:true, options: opts },
    { name:'type', label:'类型', type:'select', required:true, options:[
      { value:'投诉', label:'投诉' }, { value:'建议', label:'建议' },
      { value:'咨询', label:'咨询' }, { value:'其他', label:'其他' }] },
    { name:'title', label:'标题', required:true, placeholder:'如：楼上噪音扰民' },
    { name:'content', label:'详细内容', type:'textarea' }
  ], { room_id: owned[0].id, type:'投诉' }, async (d, modal) => {
    const r = owned.find(x => x.id === Number(d.room_id));
    await api('/api/complaints', 'POST', {
      ...d, owner_id: r ? r.owner_id : null
    });
    modal.hide(); renderComplaints();
  });
}

async function handleComplaint(id){
  openForm('处理投诉 / 建议', [
    { name:'status', label:'处理状态', type:'select', options:[
      { value:'processing', label:'处理中' }, { value:'done', label:'已办结' }] },
    { name:'handler', label:'处理人', default: ME.name },
    { name:'handle_note', label:'处理说明', type:'textarea' }
  ], { status:'done', handler: ME.name }, async (d, modal) => {
    await api('/api/complaints/' + id, 'PUT', d);
    modal.hide(); renderComplaints();
  });
}

async function delComplaint(id){
  if (!confirm('确定删除该记录？')) return;
  await api('/api/complaints/' + id, 'DELETE');
  renderComplaints();
}

/* ==================================================================
 * 18.5 宿舍管理（物业）：标记为宿舍的房产 + 员工入住关联
 * 企业管理员仅本企业；物业员工/管理员按 dorm 页面权限 + dorm_assign 操作权限
 * ================================================================== */
let dormFilter = { owner:'', q:'', status:'' };
async function renderDorms(){
  if (curMode() !== 'property') return;
  const [list, companies] = await Promise.all([
    api('/api/dorms'),
    ME.level === 'admin' ? api('/api/tenants') : Promise.resolve([])
  ]);
  const canAssign = canOp('dorm_assign');
  let rows = list.slice();
  if (dormFilter.owner) rows = rows.filter(r => r.owner_id === Number(dormFilter.owner));
  if (dormFilter.status === 'in') rows = rows.filter(r => r.count > 0);
  if (dormFilter.status === 'empty') rows = rows.filter(r => r.count === 0);
  if (dormFilter.q) rows = rows.filter(r =>
    r.room_no.includes(dormFilter.q) || (r.employees || []).some(e => e.name.includes(dormFilter.q)));
  const occupied = list.filter(r => r.count > 0).length;
  const rate = list.length ? Math.round(occupied / list.length * 100) : 0;
  $('#pageTitle').textContent = '宿舍管理';
  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto"><span class="text-muted small">共 ${list.length} 间宿舍 · 已入住 ${occupied} · 空置 ${list.length - occupied} · 入住率 ${rate}%</span></div>
      ${ME.level === 'admin' ? `<div class="col-auto"><select class="form-select form-select-sm" onchange="dormFilter.owner=this.value;renderDorms()">
        <option value="">全部企业</option>${companies.map(c => `<option value="${c.id}" ${dormFilter.owner === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>` : ''}
      <div class="col-auto"><select class="form-select form-select-sm" onchange="dormFilter.status=this.value;renderDorms()">
        <option value="">全部状态</option><option value="in" ${dormFilter.status === 'in' ? 'selected' : ''}>已入住</option>
        <option value="empty" ${dormFilter.status === 'empty' ? 'selected' : ''}>空置</option></select></div>
      <div class="col-auto"><input class="form-control form-control-sm" placeholder="搜索房间号 / 员工姓名" value="${esc(dormFilter.q)}"
        oninput="dormFilter.q=this.value;renderDorms()" style="width:220px"></div>
      ${canOp('room_add') ? '<div class="col-auto"><button class="btn btn-sm btn-primary" onclick="editRoom(undefined, renderDorms, true)">+ 新增宿舍</button></div>' : ''}
    </div>
  </div></div>
  <div class="card"><div class="card-body p-0"><table class="table table-hover mb-0 align-middle"><thead class="table-light"><tr>
    <th style="width:8%">楼栋</th><th style="width:9%">房间号</th><th style="width:7%">容量</th><th style="width:8%">入住</th>
    <th>入住员工</th><th style="width:26%">操作</th>
  </tr></thead><tbody>
  ${rows.map(r => {
    const cap = r.capacity ? (r.capacity + ' 人') : '不限';
    const over = r.over ? ' <span class="badge bg-danger">超员</span>' : '';
    const empCells = r.employees.length
      ? r.employees.map(e => `<span class="badge bg-light text-dark border me-1 mb-1">${esc(e.name)}${e.department ? '<span class="text-muted"> · ' + esc(e.department) + '</span>' : ''}</span>`).join('')
      : '<span class="text-muted small">空置</span>';
    let ops = '';
    if (canOp('room_edit')) ops += `<button class="btn btn-sm btn-outline-secondary" onclick="editRoom(${r.id}, renderDorms)">编辑</button>`;
    if (canAssign) ops += `<button class="btn btn-sm btn-outline-primary ms-1" onclick="assignDorm(${r.id})">分配</button>`;
    if (canAssign && r.count) ops += `<button class="btn btn-sm btn-outline-warning ms-1" onclick="moveDorm(${r.id})">调宿</button>
      <button class="btn btn-sm btn-outline-danger ms-1" onclick="removeDormFrom(${r.id})">退宿</button>`;
    if (!ops) ops = '<span class="text-muted small">无权限</span>';
    return `<tr>
      <td>${esc(r.building_name || '-')}</td><td>${esc(r.room_no)}</td><td>${cap}</td>
      <td>${r.count}${over}</td><td>${empCells}</td><td>${ops}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="text-center text-muted py-4">暂无宿舍（请在房产管理中将房间标记为宿舍）</td></tr>'}
  </tbody></table></div></div>`;
}
async function assignDorm(roomId){
  const [list, emps] = await Promise.all([api('/api/dorms'), api('/api/org-employees')]);
  const free = emps.filter(e => !e.room_id);
  if (!free.length){ alert('暂无未分配宿舍的员工，请先在「企业管理-企业员工」添加员工'); return; }
  openForm('分配员工入住', [
    { name:'employee_id', label:'选择员工', type:'select', options: free.map(e => ({ value: e.id, label: `${e.name}（${e.company || '未绑定企业'}）` })) },
    { name:'room_id', label:'目标宿舍', type:'select', options: list.map(r => ({ value: r.id, label: `${r.building_name || ''} ${r.room_no}（${r.count}/${r.capacity || '不限'}）` })) }
  ], { room_id: roomId }, async (d, modal) => {
    await api('/api/dorms/assign', 'PUT', d);
    modal.hide(); renderDorms();
  });
}
async function moveDorm(roomId){
  const [list, emps] = await Promise.all([api('/api/dorms'), api('/api/org-employees')]);
  const cur = (list.find(r => r.id === roomId) || {}).employees || [];
  if (!cur.length) return;
  const others = list.filter(r => r.id !== roomId);
  openForm('调宿', [
    { name:'employee_id', label:'选择员工', type:'select', options: cur.map(e => ({ value: e.id, label: `${e.name}（${e.department || ''}）` })) },
    { name:'room_id', label:'目标宿舍', type:'select', options: others.map(r => ({ value: r.id, label: `${r.building_name || ''} ${r.room_no}（${r.count}/${r.capacity || '不限'}）` })) }
  ], {}, async (d, modal) => {
    await api('/api/dorms/assign', 'PUT', d);
    modal.hide(); renderDorms();
  });
}
async function removeDormFrom(roomId){
  const [list, emps] = await Promise.all([api('/api/dorms'), api('/api/org-employees')]);
  const cur = (list.find(r => r.id === roomId) || {}).employees || [];
  if (!cur.length) return;
  openForm('退宿', [
    { name:'employee_id', label:'选择员工', type:'select', options: cur.map(e => ({ value: e.id, label: `${e.name}（${e.department || ''}）` })) }
  ], {}, async (d, modal) => {
    await api('/api/dorms/remove', 'PUT', d);
    modal.hide(); renderDorms();
  });
}

