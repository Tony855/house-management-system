'use strict';
/* ==================================================================
 * 14. 账单收费
 * ================================================================== */
let billFilter = { status:'', source:'', owner:'' };
let billCompanies = [];
/* 企业筛选：输入关键字联想（只显示包含关键字的选项），选择后按企业过滤 */
function billOwnerInput(el){
  const wrap = document.getElementById('billOwnerWrap');
  if (!wrap) return;
  if (!el.value){
    if (billFilter.owner){ billFilter.owner = ''; renderBills(); }
    wrap.style.display = 'none'; return;
  }
  const kw = el.value.trim();
  const hits = (billCompanies || []).filter(c => c.name.includes(kw));
  wrap.innerHTML = hits.slice(0, 8).map(c =>
    `<div class="sug-item" data-id="${c.id}" data-name="${esc(c.name)}"
        onmousedown="billOwnerPickItem(this)">${esc(c.name)}</div>`).join('')
    || '<div class="sug-item text-muted">无匹配企业</div>';
  wrap.style.display = 'block';
}
function billOwnerPickItem(el){
  billFilter.owner = el.dataset.id;
  const q = document.getElementById('billOwnerQ');
  if (q) q.value = el.dataset.name;
  const wrap = document.getElementById('billOwnerWrap');
  if (wrap) wrap.style.display = 'none';
  renderBills();
}
function billOwnerBlur(){
  setTimeout(() => { const w = document.getElementById('billOwnerWrap'); if (w) w.style.display = 'none'; }, 150);
}

async function renderBills(){
  const mode = curMode();
  const qs = new URLSearchParams(
    Object.entries(billFilter).filter(([, v]) => v)
  ).toString();
  const list = await api('/api/bills' + (qs ? '?' + qs : ''));
  const unpaid = list.filter(b => b.status !== 'paid')
                     .reduce((s, b) => s + (b.amount - (b.paid_amount || 0)), 0);

  const personCol = mode === 'hotel' ? '房客' : (mode === 'property' ? '企业' : '租客');

  /* 物业：企业筛选（输入企业名关键字联想，选中后按企业过滤） */
  let ownerOpts = '';
  if (mode === 'property'){
    let companies = [];
    try { companies = await api('/api/tenants'); } catch(e){}
    billCompanies = companies;
    const curName = billFilter.owner ? (companies.find(c => String(c.id) === String(billFilter.owner)) || {}).name || '' : '';
    ownerOpts = `
      <div class="col-auto" style="position:relative">
        <input class="form-control form-control-sm" id="billOwnerQ" placeholder="搜索企业"
          value="${esc(curName)}" autocomplete="off"
          oninput="billOwnerInput(this)" onfocus="billOwnerInput(this)" onblur="billOwnerBlur()">
        <div id="billOwnerWrap" class="sug-drop"></div>
      </div>`;
  }

  let genBtns = '';
  if (mode === 'rental' && canOp('bill_generate')){
    genBtns = `
      <button class="btn btn-sm btn-outline-success" onclick="generateBills('rental')">生成租金</button>
      <button class="btn btn-sm btn-outline-info" onclick="generateBills('utility')">生成水电</button>
      <button class="btn btn-sm btn-outline-primary" onclick="generateBills('network')">生成网费</button>
      <button class="btn btn-sm btn-success" onclick="generateBills('all')"><i class="bi bi-magic"></i> 全部生成</button>`;
  } else if (mode === 'hotel' && canOp('bill_generate')){
    genBtns = `<button class="btn btn-sm btn-success" onclick="generateBills('hotel')">
      <i class="bi bi-magic"></i> 补生成账单</button>`;
  } else if (canOp('bill_generate')){
    genBtns = `
      <button class="btn btn-sm btn-success" onclick="generateBills('property')">
        <i class="bi bi-magic"></i> 生成物业账单</button>
      <button class="btn btn-sm btn-primary" onclick="generateBills('network')">
        <i class="bi bi-ethernet"></i> 生成网费账单</button>
      <button class="btn btn-sm btn-outline-success" onclick="generateBills('all')">
        全部生成</button>`;
  }

  let srcOpts = '';
  if (mode === 'property'){
    srcOpts = `
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="billFilter.source=this.value;renderBills()">
          <option value="">全部来源</option>
          <option value="property"   ${billFilter.source === 'property' ? 'selected' : ''}>物业费</option>
          <option value="utility"    ${billFilter.source === 'utility' ? 'selected' : ''}>水电费</option>
          <option value="network"    ${billFilter.source === 'network' ? 'selected' : ''}>网费</option>
          <option value="net_repair" ${billFilter.source === 'net_repair' ? 'selected' : ''}>网维修费</option>
          <option value="install"    ${billFilter.source === 'install' ? 'selected' : ''}>设备安装费</option>
          <option value="repair"     ${billFilter.source === 'repair' ? 'selected' : ''}>维修费</option>
          <option value="other"      ${billFilter.source === 'other' ? 'selected' : ''}>其它</option>
        </select>
      </div>`;
  } else if (mode === 'rental'){
    srcOpts = `
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="billFilter.source=this.value;renderBills()">
          <option value="">全部来源</option>
          <option value="rental"     ${billFilter.source === 'rental' ? 'selected' : ''}>租金</option>
          <option value="utility"    ${billFilter.source === 'utility' ? 'selected' : ''}>水电</option>
          <option value="network"    ${billFilter.source === 'network' ? 'selected' : ''}>网费</option>
          <option value="net_repair" ${billFilter.source === 'net_repair' ? 'selected' : ''}>网维修费</option>
          <option value="install"    ${billFilter.source === 'install' ? 'selected' : ''}>设备安装费</option>
          <option value="repair"     ${billFilter.source === 'repair' ? 'selected' : ''}>维修费</option>
          <option value="other"      ${billFilter.source === 'other' ? 'selected' : ''}>其它</option>
        </select>
      </div>`;
  }

  $('#page').innerHTML = `
  <div class="card mb-3"><div class="card-body py-2">
    <div class="row g-2 align-items-center">
      <div class="col-auto">
        <select class="form-select form-select-sm" onchange="billFilter.status=this.value;renderBills()">
          <option value="">全部状态</option>
          <option value="unpaid"  ${billFilter.status === 'unpaid' ? 'selected' : ''}>未支付</option>
          <option value="partial" ${billFilter.status === 'partial' ? 'selected' : ''}>部分支付</option>
          <option value="paid"    ${billFilter.status === 'paid' ? 'selected' : ''}>已结清</option>
        </select>
      </div>
      ${srcOpts}
      ${ownerOpts}
      <div class="col-auto">${genBtns}</div>
      <div class="col-auto">${canOp('bill_add') ? `<button class="btn btn-sm btn-outline-primary" onclick="editBill()">+ 手动添加</button>` : ''}</div>
      <div class="col-auto text-muted small">${ME.level === 'company_admin'
        ? `未付合计 <span class="text-danger fw-bold">${money(unpaid)}</span>`
        : `共 ${list.length} 条 · 未收合计 <span class="text-danger fw-bold">${money(unpaid)}</span>`}</div>
    </div>
  </div></div>
  <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
    <thead class="table-light"><tr>
      <th>来源</th><th>楼栋/房间</th><th>${personCol}</th>
      <th>费用周期</th><th>应缴日期</th><th>应缴</th><th>已缴</th>
      <th>状态</th><th>缴费方式</th>${canAnyOp('bill_add','bill_generate','bill_delete','bill_pay','bill_print') ? '<th width="250">操作</th>' : ''}
    </tr></thead>
    <tbody>${list.map(b => {
      const src = BILL_SOURCE[b.source] || [b.source, 'secondary'];
      return `<tr>
      <td><span class="badge bg-${src[1]}${src[1] === 'warning' ? ' text-dark' : ''}">${src[0]}</span></td>
      <td><b>${esc(b.building_name || '')} ${esc(b.room_no || '-')}</b></td>
      <td>${esc(b.tenant_name || '-')}</td>
      <td><small>${b.period_start} ~ ${b.period_end}</small>
          ${b.remark ? `<div class="text-muted" style="font-size:12px">${esc(b.remark)}</div>` : ''}
          ${fmtItems(b.items)}</td>
      <td>${b.due_date}</td>
      <td>${money(b.amount)}</td>
      <td>${money(b.paid_amount)}</td>
      <td>${billBadge(b.status)}</td>
      <td>${esc(b.pay_method || '-')}</td>
      <td>
        ${canAnyOp('bill_add','bill_generate','bill_delete','bill_pay','bill_print') ? 
          (canOp('bill_print') ? `<button class="btn btn-sm btn-outline-secondary" onclick="printBill(${b.id})">打印</button>` : '')
          + (b.status !== 'paid' && canOp('bill_pay')
          ? `<button class="btn btn-sm btn-success"
               onclick="payBill(${b.id}, ${(b.amount - (b.paid_amount || 0)).toFixed(2)})">收款</button>` : '')
          + (canOp('bill_delete') ? `<button class="btn btn-sm btn-outline-danger" onclick="delBill(${b.id})">删除</button>` : '') : ''}
      </td></tr>`;
    }).join('') || '<tr><td colspan="10" class="text-center text-muted py-4">暂无数据</td></tr>'}
    </tbody></table></div></div>`;
}

async function generateBills(kind){
  const tips = {
    rental:'为所有履行中的合同生成下一期租金账单？',
    utility:'为所有已出租房产生成当月水电费账单（按本月抄表读数）？',
    hotel:'补生成已退房但未结算的账单？',
    property:'为所有已绑定企业的房产生成当月物业账单（物业费 + 水费 + 电费，不含网费）？',
    network:'为所有计费房产生成当月网费账单？\n（按兆数 × 每兆月租 × 天数分段计算）',
    all: curMode() === 'rental'
      ? '生成所有符合条件的账单？（租金 + 水电 + 网费）'
      : '生成所有符合条件的账单？（物业账单 + 网费账单）'
  };
  if (!confirm(tips[kind] || '确定生成账单？')) return;
  try {
    const r = await api('/api/bills/generate', 'POST', { kind });
    const extra = (r.detail && r.detail.length)
      ? '\n\n跳过明细：\n' + r.detail.map(d => '· ' + d.room + ' — ' + d.reason).join('\n') : '';
    alert(r.msg + extra);
    renderBills();
  } catch(e){ alert(e.message); }
}

async function editBill(){
  const mode = curMode();
  const t = today();
  const ym = curMonth();

  if (mode === 'rental'){
    const contracts = await safeApi('/api/contracts?status=active');
    if (!contracts) return;
    if (!contracts.length){ alert('没有履行中的合同'); return; }
    openForm('手动添加账单', [
      { name:'contract_id', label:'合同', type:'select', required:true,
        options: contracts.map(c => ({ value:c.id,
          label:`${c.contract_no} | ${c.room_no} | ${c.tenant_name}` })) },
      { name:'period_start', label:'费用起始日', type:'date', required:true, default:t },
      { name:'period_end',   label:'费用截止日', type:'date', required:true, default:t },
      { name:'due_date',     label:'应缴日期',   type:'date', required:true, default:t },
      { name:'amount',       label:'金额', type:'number', required:true, step:'0.01',
        money:true, default: contracts[0].rent },
      { name:'remark', label:'备注', type:'textarea' }
    ], {}, async (d, modal) => {
      const c = contracts.find(x => x.id === Number(d.contract_id));
      await api('/api/bills', 'POST', {
        ...d, source:'rental', room_id: c.room_id,
        tenant_id: c.tenant_id, contract_id: c.id
      });
      modal.hide(); renderBills();
    });
    return;
  }

  if (mode === 'hotel'){
    const rooms = await safeApi('/api/rooms');
    if (!rooms) return;
    if (!rooms.length){ alert('请先创建房间'); return; }
    openForm('手动添加账单', [
      { name:'room_id', label:'房间', type:'select', required:true,
        options: rooms.map(r => ({ value:r.id, label:`${r.building_name || ''} ${r.room_no}` })) },
      { name:'period_start', label:'起始日', type:'date', required:true, default:t },
      { name:'period_end',   label:'截止日', type:'date', required:true, default:t },
      { name:'due_date',     label:'应缴日期', type:'date', required:true, default:t },
      { name:'amount',       label:'金额', type:'number', required:true, step:'0.01', money:true },
      { name:'remark', label:'备注', type:'textarea' }
    ], {}, async (d, modal) => {
      await api('/api/bills', 'POST', { ...d, source:'hotel' });
      modal.hide(); renderBills();
    });
    return;
  }

  /* 物业模式：让用户选择来源 */
  const rooms = await safeApi('/api/rooms');
  if (!rooms) return;
  const owned = rooms.filter(r => r.owner_id);
  if (!owned.length){ alert('请先在房产管理中为房屋绑定企业'); return; }

  openForm('手动添加账单', [
    { name:'source', label:'账单来源', type:'select', required:true, options:[
      { value:'property', label:'物业费' },
      { value:'utility',  label:'水电费' },
      { value:'network',  label:'网费' },
      { value:'net_repair', label:'网维修费' },
      { value:'install',    label:'设备安装费' },
      { value:'repair',     label:'维修费' },
      { value:'other',      label:'其它' }] },
    { name:'room_id', label:'房产', type:'select', required:true,
      options: owned.map(r => ({ value:r.id,
        label:`${r.building_name || ''} ${r.room_no}｜${r.owner_name || ''}` })) },
    { name:'period_start', label:'费用起始日', type:'date', required:true, default: monthStart(t) },
    { name:'period_end',   label:'费用截止日', type:'date', required:true,
      default: addDays(addMonths(monthStart(t), 1), -1) },
    { name:'due_date',     label:'应缴日期', type:'date', required:true, default: ym + '-10' },
    { name:'amount',       label:'金额', type:'number', required:true, step:'0.01', money:true, default:0 },
    { name:'items', label:'明细清单', type:'items', hint:'维修/安装/其它类可录入明细行，合计自动填入金额' },
    { name:'remark', label:'备注', type:'textarea' }
  ], { source:'property' }, async (d, modal) => {
    if (d.source === 'other' && !(d.remark || '').trim()){ alert('选择「其它」来源时请填写备注说明'); return; }
    const r = owned.find(x => x.id === Number(d.room_id));
    await api('/api/bills', 'POST', {
      ...d, room_id: r.id, tenant_id: r.owner_id
    });
    modal.hide(); renderBills();
  }, (el) => {
    /* 明细清单仅对维修/安装/其它类来源显示 */
    const $ = n => el.querySelector(`[name="${n}"]`);
    const src = $('source'), wrap = el.querySelector('.item-wrap'), amt = $('amount');
    if (!wrap) return;
    const sync = () => {
      const show = ['net_repair','install','repair','other'].includes(src.value);
      wrap.style.display = show ? '' : 'none';
      if (!show){ amt.readOnly = false; amt.value = ''; }
    };
    src.addEventListener('change', sync);
    sync();
  });
}

async function payBill(id, rest){
  const t = today();
  openForm('收款登记', [
    { name:'amount', label:'收款金额', type:'number', required:true, step:'0.01',
      money:true, default: rest },
    { name:'pay_date', label:'收款日期', type:'date', default:t },
    { name:'pay_method', label:'收款方式', type:'select', options:[
      { value:'现金', label:'现金' }, { value:'微信', label:'微信' },
      { value:'支付宝', label:'支付宝' }, { value:'银行转账', label:'银行转账' },
      { value:'其他', label:'其他' }] }
  ], {}, async (d, modal) => {
    await api(`/api/bills/${id}/pay`, 'POST', d);
    modal.hide(); renderBills();
  });
}

async function delBill(id){
  if (!confirm('确定删除该账单？')) return;
  await api('/api/bills/' + id, 'DELETE');
  renderBills();
}

/* 打印账单（A4 排版，含明细清单与收款信息；弹窗被拦时提示放行） */
async function printBill(id){
  const all = await api('/api/bills');
  const b = all.find(x => x.id === id);
  if (!b){ alert('未找到该账单'); return; }
  const w = window.open('', '_blank', 'width=820,height=920');
  if (!w){ alert('浏览器拦截了打印窗口，请允许本站弹窗后重试'); return; }
  const src = (BILL_SOURCE[b.source] || [b.source])[0];
  const due = Number(b.amount) - Number(b.paid_amount || 0);
  const itemsHtml = (Array.isArray(b.items) && b.items.length) ? `
    <table>
      <tr><th style="width:36%">商品</th><th style="width:24%">型号</th><th class="c" style="width:10%">数量</th><th class="c" style="width:15%">单价</th><th class="c" style="width:15%">金额</th></tr>
      ${b.items.map(it => (it.qty == null && it.price == null)
        ? `<tr><td colspan="5" class="note">${esc(it.name)}（说明）</td></tr>`
        : `<tr><td>${esc(it.name)}</td><td>${esc(it.model || '-')}</td>
            <td class="c">${it.qty}</td><td class="c">${money(it.price)}</td>
            <td class="c">${money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td></tr>`).join('')}
    </table>` : '<div class="muted">（无明细）</div>';
  const h = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>账单 #${b.id}</title>
  <style>
    body{font-family:'Microsoft YaHei',Arial,sans-serif;color:#222;max-width:720px;margin:24px auto;padding:0 16px;font-size:13px}
    .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:14px}
    h1{margin:0;font-size:20px}.sub{color:#555;font-size:12px}
    table{width:100%;border-collapse:collapse;margin:8px 0 14px}
    th,td{border:1px solid #999;padding:6px 8px;text-align:left}
    th{background:#f0f0f0}.c{text-align:center}
    .note{color:#777;font-style:italic}
    .meta{display:flex;flex-wrap:wrap;gap:6px 30px;margin:8px 0 14px}
    .meta span b{display:inline-block;min-width:70px;color:#555}
    .sum{display:flex;justify-content:flex-end;gap:18px;font-size:14px;margin-top:6px}
    .sum .amt{font-weight:bold;font-size:16px}
    .foot{margin-top:30px;display:flex;justify-content:space-between;color:#555;font-size:12px;border-top:1px dashed #999;padding-top:8px}
    .btn-bar{text-align:center;margin:16px 0}
    .btn-bar button{padding:8px 30px;font-size:14px;cursor:pointer}
    @media print{.btn-bar{display:none}body{margin:8px}}
  </style></head><body>
  <div class="btn-bar"><button onclick="window.print()">打印 / 另存为 PDF</button></div>
  <div class="head">
    <div><h1>${esc(MODE_NAME[curMode()] || '')}系统 · 账单</h1>
      <div class="sub">${esc(ME.org_name || '')} · 账单号 #${b.id}</div></div>
    <div class="sub">状态：<b>${b.status === 'paid' ? '已收款' : '未收款'}</b> · 来源：${esc(src)}</div>
  </div>
  <div class="meta">
    <span><b>楼栋/房号</b>${esc(b.building_name || '')} ${esc(b.room_no || '-')}</span>
    <span><b>客户</b>${esc(b.tenant_name || '-')}</span>
    <span><b>费用周期</b>${b.period_start} ~ ${b.period_end}</span>
    <span><b>应缴日期</b>${b.due_date || '-'}</span>
    <span><b>收款方式</b>${esc(b.pay_method || '-')}</span>
    ${b.pay_date ? `<span><b>收款日期</b>${b.pay_date}</span>` : ''}
  </div>
  ${itemsHtml}
  <div class="sum">
    <span>应缴：<span class="amt">${money(b.amount)}</span></span>
    <span>已缴：${money(b.paid_amount || 0)}</span>
    <span>未缴：<b>${money(Math.max(due, 0))}</b></span>
  </div>
  ${b.remark ? `<div class="muted" style="color:#555">备注：${esc(b.remark)}</div>` : ''}
  <div class="foot"><span>生成时间：${new Date().toLocaleString()}</span><span>${esc(ME.org_name || '')} · ${MODE_NAME[curMode()] || ''}系统</span></div>
  </body></html>`;
  w.document.write(h);
  w.document.close();
  setTimeout(() => { try { w.print(); } catch(e){} }, 350);
}

