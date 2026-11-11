'use strict';
/* ==================================================================
 *  0. 通用工具
 * ================================================================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const p2 = n => String(n).padStart(2, '0');
/* ===== 统一提示弹窗（替代原生 alert）：居中卡片 + 图标 + 动画 ===== */
function showUiDialog(msg, type){
  type = type || 'info';
  const icons = { info: '<i class="bi bi-info-circle-fill"></i>', warn: '<i class="bi bi-exclamation-triangle-fill"></i>',
    err: '<i class="bi bi-x-circle-fill"></i>', ok: '<i class="bi bi-check-circle-fill"></i>' };
  const titles = { info: '提示', warn: '警告', err: '出错了', ok: '成功' };
  const mask = document.createElement('div');
  mask.className = 'ui-dialog-mask';
  mask.innerHTML = `<div class="ui-dialog">
    <div class="ui-dialog-icon ${type === 'err' ? 'err' : type === 'warn' ? 'warn' : type === 'ok' ? 'ok' : ''}">${icons[type] || icons.info}</div>
    <div class="ui-dialog-title">${titles[type] || titles.info}</div>
    <div class="ui-dialog-body">${esc(msg)}</div>
    <div class="ui-dialog-actions"><button class="btn btn-primary">确 定</button></div>
  </div>`;
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Enter' || e.key === 'Escape') close(); };
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  mask.querySelector('button').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(mask);
  mask.querySelector('.ui-dialog button').focus();
}
/* 全局接管原生 alert：所有提示统一走自定义弹窗 */
window.alert = (msg) => showUiDialog(String(msg ?? ''), 'info');

function today(){
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
}
function nowStr(){
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function addDays(dateStr, n){
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
}
function addMonths(dateStr, n){
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0);
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
}
function daysBetween(a, b){
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  return Math.max(1, Math.round((d2 - d1) / 86400000));
}
function monthStart(dateStr){ return dateStr.slice(0, 7) + '-01'; }
function curMonth(){ return today().slice(0, 7); }

/* ==================================================================
 *  1. 币种 / 金额
 * ================================================================== */
function getCurrency(){ return (DB.data && DB.data.settings.currency) || 'USD'; }
function getRate(){ const r = Number(DB.data && DB.data.settings.rate); return r > 0 ? r : 7.2; }
function currencySymbol(){ return getCurrency() === 'USD' ? '$' : '¥'; }
function money(v){
  const n = Number(v) || 0;
  if (getCurrency() === 'USD') return '$' + (n / getRate()).toFixed(2);
  return '¥' + n.toFixed(2);
}
function toDisplayMoney(cny){
  const n = Number(cny) || 0;
  return getCurrency() === 'USD' ? (n / getRate()).toFixed(2) : n.toFixed(2);
}
function fromDisplayMoney(v){
  const n = Number(v) || 0;
  return getCurrency() === 'USD' ? n * getRate() : n;
}
/* 数字输入框禁用键盘上下键增减数值 */
document.addEventListener('keydown', function(e){
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target && e.target.type === 'number') e.preventDefault();
});

/* ==================================================================
 *  2. 全局设置（模式 / 币种 / 汇率 / 网费单价，启动时从后端加载）
 * ================================================================== */
const DB = { data: { settings: { mode: 'hotel', currency: 'USD', rate: 7.2, net_price_per_mb: 1, water_price: 4.5, elec_price: 1 } } };

/* ==================================================================
 *  3. 常量
 * ================================================================== */
const MODE_NAME = { rental:'租房', hotel:'酒店', property:'物业综合管理' };
const MODE_TAB = { rental:'租房', hotel:'酒店', property:'物业' };
const DEFAULT_PAGE = { rental:'dashboard', hotel:'roommap', property:'dashboard' };
/* 三个系统：租房 / 酒店 / 物业 */
const MODES = ['rental', 'hotel', 'property'];

let ME = null;

const STATUS_TEXT = {
  vacant:      { rental:'空置',   hotel:'空闲',   property:'空置' },
  rented:      { rental:'已出租', hotel:'已入住', property:'已入住' },
  booked:      { rental:'已预订', hotel:'已预订', property:'已预订' },
  cleaning:    { rental:'待清洁', hotel:'待清洁', property:'空置' },
  maintenance: { rental:'维修中', hotel:'维修中', property:'维修中' }
};
const STATUS_COLOR = { vacant:'secondary', rented:'success', booked:'primary',
                       cleaning:'warning', maintenance:'danger' };
const STATUS_HEX = { vacant:'#6b7280', rented:'#16a34a', booked:'#2563eb',
                     cleaning:'#f59e0b', maintenance:'#dc2626' };
const ORDER_STATUS = {
  booked:['已预订','primary'], checked_in:['已入住','success'],
  checked_out:['已退房','secondary'], cancelled:['已取消','dark']
};
const BILL_STATUS = {
  unpaid:['未支付','danger'], partial:['部分支付','warning'], paid:['已结清','success']
};
const BILL_SOURCE = {
  rental:['租金','secondary'], utility:['水电','info'], hotel:['酒店','info'],
  property:['物业','warning'], network:['网费','primary'],
  net_repair:['网维修','danger'], install:['设备安装','success'],
  repair:['维修','warning'], other:['其它','secondary']
};
const CONTRACT_STATUS = {
  active:['履行中','success'], expired:['已到期','secondary'], terminated:['已终止','dark']
};
const REPAIR_STATUS = {
  pending:['待处理','danger'], processing:['处理中','warning'], done:['已完成','success']
};
const COMPLAINT_STATUS = {
  pending:['待处理','danger'], processing:['处理中','warning'], done:['已办结','success']
};

function statusBadge(s, mode){
  mode = mode || curMode();
  const txt = (STATUS_TEXT[s] && STATUS_TEXT[s][mode]) || s;
  const c = STATUS_COLOR[s] || 'secondary';
  return `<span class="badge bg-${c}${c === 'warning' ? ' text-dark' : ''}">${txt}</span>`;
}
function mkBadge(map){
  return s => {
    const it = map[s] || [s, 'secondary'];
    return `<span class="badge bg-${it[1]}${it[1] === 'warning' ? ' text-dark' : ''}">${it[0]}</span>`;
  };
}
const orderBadge      = mkBadge(ORDER_STATUS);
const billBadge       = mkBadge(BILL_STATUS);
const contractBadge   = mkBadge(CONTRACT_STATUS);
const repairBadge     = mkBadge(REPAIR_STATUS);
const complaintBadge  = mkBadge(COMPLAINT_STATUS);
const cycleText = n => ({ 1:'月付', 3:'季付', 6:'半年付', 12:'年付' }[n] || n + '个月');



/* ==================================================================
 *  5. 后端 API 封装（真实请求 Node.js + MariaDB）
 * ================================================================== */
function curUser(){ return ME; }

async function api(path, method = 'GET', data){
  const opt = { method, headers: {} };
  const token = sessionStorage.getItem('house_token');
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (data !== undefined && data !== null && method.toUpperCase() !== 'GET'){
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(data);
  }
  const res = await fetch(path, opt);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || '请求失败（' + res.status + '）');
  return body;
}

/* 安全请求：加载失败时明确弹窗提示并返回 null（避免"点击无反应"式静默失败） */
async function safeApi(path, method, data){
  try { return await api(path, method, data); }
  catch(e){ alert(e.message); return null; }
}

/* ==================================================================
 *  6. 通用 UI 组件
 * ================================================================== */
function openForm(title, fields, values, onSubmit, onMount){
  values = values || {};
  const mid = 'fm' + Date.now();
  /* 含明细清单的弹窗自动加宽，避免商品/型号等字段显示不完整（固定宽度，不随视口退化） */
  const wide = fields.some(f => f.type === 'items') ? ' style="max-width:920px"' : '';
  let html = `<div class="modal fade" id="${mid}" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered"${wide}>
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5>
          <button class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body"><form id="${mid}_f">`;

  fields.forEach(f => {
    let v = values[f.name];
    if (v === undefined || v === null || v === '') v = f.default !== undefined ? f.default : '';
    if (f.money && v !== '' && v !== null) v = toDisplayMoney(v);
    const label = esc(f.label) + (f.money ? ` <span class="text-muted">(${currencySymbol()})</span>` : '')
                + (f.required ? ' <span class="text-danger">*</span>' : '');

    html += `<div class="mb-3"><label class="form-label">${label}</label>`;
    if (f.type === 'select'){
      html += `<select class="form-select" name="${f.name}" ${f.required ? 'required' : ''}>`;
      if (!f.required) html += `<option value="">-- 请选择 --</option>`;
      (f.options || []).forEach(o => {
        html += `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`;
      });
      html += `</select>`;
    } else if (f.type === 'textarea'){
      html += `<textarea class="form-control" name="${f.name}" rows="2">${esc(v)}</textarea>`;
    } else if (f.type === 'checklist'){
      html += `<div class="d-flex flex-wrap gap-1">`;
      (f.options || []).forEach(o => {
        if (o.type === 'group'){
          html += `<div class="w-100 op-group-title mt-1 mb-0">${esc(o.label)}</div>`;
          return;
        }
        const checked = (Array.isArray(v) && v.includes(o.value)) ? 'checked' : '';
        html += `<label class="form-check me-3 op-item">
          <input class="form-check-input" type="checkbox" name="${f.name}" value="${esc(o.value)}" ${checked}>
          <span class="form-check-label">${esc(o.label)}</span></label>`;
      });
      html += `</div>`;
    } else if (f.type === 'items'){
      /* 明细清单：动态行（商品/型号/数量/单价），金额自动合计；勾选说明行则不计金额
         cat: ''=全部类别 | 'net'=网络商品 | 'util'=水电商品（按入口过滤商品库） */
      const libBtn = (typeof canOp === 'function' && canOp('itemlib_use'))
        ? `<button type="button" class="btn btn-sm btn-outline-primary" onclick="openLibPicker('${mid}_${f.name}')"><i class="bi bi-journal-text"></i> 从商品库添加</button>` : '';
      html += `<div class="item-wrap" data-cat="${esc(f.cat || '')}">
        <div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-1">
          <thead class="table-light text-center"><tr>
            <th style="min-width:150px">商品</th>
            <th style="min-width:120px">型号</th>
            <th style="width:80px">数量</th>
            <th style="width:110px">单价(${currencySymbol()})</th>
            <th style="width:96px">金额</th>
            <th style="width:56px">说明</th>
            <th style="width:76px"></th></tr></thead>
          <tbody id="${mid}_${f.name}_tb"></tbody>
        </table></div>
        <div class="d-flex justify-content-between align-items-center">
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-sm btn-outline-secondary" onclick="addItemRow('${mid}_${f.name}')">+ 添加明细行</button>
            ${libBtn}
          </div>
          <span class="fw-bold item-sum">合计：${currencySymbol()}0.00</span>
        </div>
        ${f.hint ? `<div class="form-text">${esc(f.hint)}</div>` : ''}
      </div>`;
    } else if (f.type === 'file'){
      /* 图片上传：选文件后转 base64 上传，URL 存入 hidden 随表单提交 */
      html += `<input class="form-control" type="file" accept="image/jpeg,image/png,image/webp"
                onchange="uploadPhoto(this, document.getElementById('${mid}_${f.name}'), document.getElementById('${mid}_${f.name}_img'))">`;
      html += `<input type="hidden" name="${f.name}" id="${mid}_${f.name}" value="${esc(v)}">`;
      html += `<img id="${mid}_${f.name}_img" src="${esc(v)}" class="mt-1 rounded border"
                style="max-height:90px;max-width:140px;object-fit:cover;${v ? '' : 'display:none'}">`;
    } else if (f.type === 'checkbox'){
      html += `<input class="form-check-input" type="checkbox" name="${f.name}" value="1" ${v ? 'checked' : ''}>`;
    } else {
      html += `<input class="form-control" type="${f.type || 'text'}" name="${f.name}"
        value="${esc(f.type === 'number' && !f.money && v !== '' && v != null ? Number(v) : v)}" ${f.required ? 'required' : ''}
        ${f.step ? `step="${f.step}"` : (f.money ? 'step="0.01"' : '')}
        ${f.readonly ? 'readonly' : ''}
        ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
    }
    if (f.hint) html += `<div class="form-text">${esc(f.hint)}</div>`;
    html += `</div>`;
  });

  html += `</form></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
          <button class="btn btn-primary" id="${mid}_ok">保存</button>
        </div></div></div></div>`;

  $('#modalHost').insertAdjacentHTML('beforeend', html);
  const el = document.getElementById(mid);
  const modal = new bootstrap.Modal(el);

  el.querySelector(`#${mid}_ok`).onclick = async () => {
    const form = el.querySelector(`#${mid}_f`);
    if (!form.checkValidity()){ form.reportValidity(); return; }
    const data = {};
    new FormData(form).forEach((val, key) => { data[key] = val === '' ? null : val; });
    fields.forEach(f => {
      if (f.type === 'checklist'){
        data[f.name] = [...el.querySelectorAll(`input[name="${f.name}"]:checked`)].map(i => i.value);
        return;
      }
      if (f.type === 'items'){
        data[f.name] = collectItems(el.querySelector(`#${mid}_${f.name}_tb`));
        return;
      }
      if (data[f.name] === null) return;
      if (f.type === 'number') data[f.name] = Number(data[f.name]);
      if (f.money) data[f.name] = fromDisplayMoney(data[f.name]);
    });
    try { await onSubmit(data, modal); }
    catch(e){ alert(e.message || '操作失败'); }
  };

  el.addEventListener('hidden.bs.modal', () => el.remove());
  /* 明细控件初始空行 */
  fields.forEach(f => {
    if (f.type === 'items'){
      const tb = el.querySelector(`#${mid}_${f.name}_tb`);
      if (tb && !tb.children.length) addItemRow(`${mid}_${f.name}`);
    }
  });
  modal.show();
  if (onMount) onMount(el);
}

/* ===== 账单明细清单（维修/安装/其它类） ===== */
function addItemRow(id){
  const tb = document.getElementById(id + '_tb');
  if (!tb) return;
  if (tb.children.length >= 50){ alert('明细最多 50 行'); return; }
  const tr = document.createElement('tr');
  const suggestAttr = (typeof canOp === 'function' && canOp('itemlib_use'))
    ? 'oninput="libSuggest(this)" onfocus="libSuggest(this)"' : '';
  tr.innerHTML = `
    <td><input class="form-control form-control-sm" data-f="name" placeholder="商品名称" ${suggestAttr}></td>
    <td><input class="form-control form-control-sm" data-f="model" placeholder="型号"></td>
    <td><input class="form-control form-control-sm" data-f="qty" type="number" min="1" step="1" placeholder="数量"></td>
    <td><input class="form-control form-control-sm" data-f="price" type="number" min="0" step="0.01" placeholder="单价"></td>
    <td class="text-end item-amt text-muted">-</td>
    <td class="text-center"><input type="checkbox" class="form-check-input" data-f="free" title="说明行：只记说明不计金额" onchange="toggleItemFree(this)"></td>
    <td class="text-center text-nowrap">
      <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" title="复制上一行" onclick="copyPrevRow(this)">⧉</button>
      <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" title="删除该行" onclick="delItemRow(this)">×</button></td>`;
  tb.appendChild(tr);
  tr.querySelectorAll('input[data-f]').forEach(inp => {
    inp.addEventListener('input', () => updateItemRow(tb));
  });
  updateItemRow(tb);
}
function toggleItemFree(cb){
  const tr = cb.closest('tr');
  const qInp = tr.querySelector('[data-f="qty"]'), pInp = tr.querySelector('[data-f="price"]');
  qInp.disabled = cb.checked; pInp.disabled = cb.checked;
  if (cb.checked){ qInp.value = ''; pInp.value = ''; }
  updateItemRow(tr.closest('tbody'));
}
function delItemRow(btn){
  const tb = btn.closest('tbody');
  btn.closest('tr').remove();
  updateItemRow(tb);
}
/* ===== 常用商品库：联想 / 复制上一行 / 从商品库批量添加（按经营主体隔离） ===== */
let _libSuggest = null;
function itemLib(){ return (DB.data.settings && DB.data.settings.item_lib) || []; }
/* 当前明细弹窗允许的商品库类别：''=全部 | 'net' | 'util'（从 .item-wrap data-cat 读取） */
function libCat(inp){
  const wrap = inp ? inp.closest('.item-wrap') : null;
  return (wrap && wrap.getAttribute('data-cat')) || '';
}
function libFiltered(cat){
  const lib = itemLib();
  if (!cat) return lib;                          /* 全部入口：网络+水电两类都显示 */
  if (cat === 'util') return lib.filter(it => it.cat === 'util');
  /* 网络入口：网络商品 + 历史未分类商品（默认归网络） */
  return lib.filter(it => it.cat !== 'util');
}
function hideLibSuggest(){ if (_libSuggest){ _libSuggest.remove(); _libSuggest = null; } }
function libSuggest(inp){
  hideLibSuggest();
  const kw = (inp.value || '').trim();
  const cat = libCat(inp);
  const lib = libFiltered(cat);
  if (!kw || !lib.length) return;
  const list = lib.filter(it => it.name.includes(kw) || ((it.model || '') && it.model.includes(kw))).slice(0, 8);
  if (!list.length) return;
  const r = inp.getBoundingClientRect();
  const div = document.createElement('div');
  div.className = 'lib-suggest';
  div.style.cssText = `position:fixed;z-index:2000;background:#fff;border:1px solid #d0d7de;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.15);max-height:260px;overflow:auto;min-width:${Math.max(r.width, 280)}px;top:${r.bottom + 4}px;left:${r.left}px;`;
  list.forEach(it => {
    const row = document.createElement('div');
    row.style.cssText = 'cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:center;padding:6px 10px;font-size:13px;';
    row.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}${it.model ? '<span class="text-muted"> · ' + esc(it.model) + '</span>' : ''}</span><span class="text-muted text-nowrap">${money(it.price)}</span>`;
    row.onmouseenter = () => row.style.background = '#f1f5f9';
    row.onmouseleave = () => row.style.background = '';
    row.onmousedown = (e) => { e.preventDefault(); pickLibItem(inp, it); };
    div.appendChild(row);
  });
  document.body.appendChild(div);
  _libSuggest = div;
}
function pickLibItem(inp, it){
  hideLibSuggest();
  const tr = inp.closest('tr');
  const nameInp = tr.querySelector('[data-f="name"]');
  nameInp.value = it.name;
  const m = tr.querySelector('[data-f="model"]'); if (m) m.value = it.model || '';
  const p = tr.querySelector('[data-f="price"]');
  if (p){ p.value = toDisplayMoney(it.price); p.dispatchEvent(new Event('input', { bubbles:true })); }
  nameInp.dispatchEvent(new Event('input', { bubbles:true }));
  updateItemRow(tr.closest('tbody'));
}
function copyPrevRow(btn){
  const tr = btn.closest('tr');
  const tb = tr.closest('tbody');
  const idx = [...tb.rows].indexOf(tr);
  if (idx < 1) return;
  const prev = tb.rows[idx - 1];
  const pv = n => (prev.querySelector('[data-f="' + n + '"]') || {}).value || '';
  const qv = n => (prev.querySelector('[data-f="' + n + '"]') || {}).disabled;
  tr.querySelector('[data-f="name"]').value = pv('name');
  const m = tr.querySelector('[data-f="model"]'); if (m) m.value = pv('model');
  const q = tr.querySelector('[data-f="qty"]'), p = tr.querySelector('[data-f="price"]');
  q.value = ''; q.disabled = qv('qty');
  p.value = pv('price'); p.disabled = qv('price');
  const cb = tr.querySelector('[data-f="free"]');
  if (cb) cb.checked = !!(prev.querySelector('[data-f="free"]') || {}).checked;
  q.dispatchEvent(new Event('input', { bubbles:true }));
  p.dispatchEvent(new Event('input', { bubbles:true }));
  updateItemRow(tb);
}
async function openLibPicker(id){
  /* 实时刷新商品库：主管理员刚保存后，本会话/其他会话无需重新登录即可看到最新数据 */
  try {
    const st = await api('/api/settings');
    if (Array.isArray(st.item_lib)) DB.data.settings.item_lib = st.item_lib;
  } catch(e){ /* 拉取失败时沿用会话内缓存 */ }
  const tb = document.getElementById(id + '_tb');
  const wrap = tb && tb.closest('.item-wrap');
  const cat = (wrap && wrap.getAttribute('data-cat')) || '';
  const lib = libFiltered(cat);
  if (!lib.length){ alert(cat === 'net' ? '网络商品库暂无数据，请主管理员在「系统设置」中添加' : cat === 'util' ? '水电商品库暂无数据，请主管理员在「系统设置」中添加' : '商品库暂无数据，请主管理员在「系统设置」中先添加常用商品'); return; }
  hideLibSuggest();
  const host = document.getElementById('modalHost') || document.body;
  const mid = 'libpk' + Date.now();
  const catTxt = cat === 'net' ? '（网络商品）' : cat === 'util' ? '（水电商品）' : '';
  const html = `
    <div class="modal fade" id="${mid}" tabindex="-1">
      <div class="modal-dialog modal-dialog-centered modal-lg"><div class="modal-content">
        <div class="modal-header py-2"><h6 class="modal-title">从商品库添加${catTxt}</h6>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body p-2">
          <div class="table-responsive" style="max-height:420px"><table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light"><tr><th style="width:40px"></th><th>商品</th><th style="width:150px">型号</th><th style="width:110px">单价(${currencySymbol()})</th></tr></thead>
            <tbody>
              ${lib.map((it, i) => `<tr>
                <td class="text-center"><input type="checkbox" class="form-check-input lib-chk" data-idx="${i}"></td>
                <td style="word-break:break-all">${esc(it.name)}</td>
                <td class="text-muted" style="word-break:break-all">${esc(it.model || '-')}</td>
                <td>${money(it.price)}</td></tr>`).join('')}
            </tbody></table></div>
          <div class="form-text mt-1">勾选后点击「添加所选」自动生成明细行，型号与单价自动带出，数量请自行填写。</div>
        </div>
        <div class="modal-footer py-2">
          <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="libPickConfirm('${mid}','${id}')">添加所选</button>
        </div>
      </div></div></div>`;
  host.insertAdjacentHTML('beforeend', html);
  const el = document.getElementById(mid);
  el.addEventListener('hidden.bs.modal', () => el.remove());
  bootstrap.Modal.getOrCreateInstance(el).show();
}
function libPickConfirm(mid, id){
  const lib = itemLib();
  const sel = [...document.querySelectorAll('#' + mid + ' .lib-chk')].filter(c => c.checked)
    .map(c => lib[Number(c.dataset.idx)]);
  if (!sel.length){ alert('请先勾选商品'); return; }
  const tb = document.getElementById(id + '_tb');
  const tr0 = tb.rows[0];
  if (tr0 && !(tr0.querySelector('[data-f="name"]').value.trim())) tb.rows[0].remove();
  sel.forEach(it => {
    addItemRow(id);
    const tr = tb.rows[tb.rows.length - 1];
    tr.querySelector('[data-f="name"]').value = it.name;
    const m = tr.querySelector('[data-f="model"]'); if (m) m.value = it.model || '';
    const p = tr.querySelector('[data-f="price"]');
    if (p){ p.value = toDisplayMoney(it.price); p.dispatchEvent(new Event('input', { bubbles:true })); }
    tr.querySelector('[data-f="qty"]').dispatchEvent(new Event('input', { bubbles:true }));
  });
  const inst = bootstrap.Modal.getInstance(document.getElementById(mid));
  if (inst) inst.hide();
  updateItemRow(tb);
}
/* 点击页面其它处关闭联想 */
document.addEventListener('click', e => {
  if (!e.target.closest('.lib-suggest')) hideLibSuggest();
});
function updateItemRow(tb){
  if (!tb) return;
  let sum = 0;
  [...tb.rows].forEach(tr => {
    const qInp = tr.querySelector('[data-f="qty"]'), pInp = tr.querySelector('[data-f="price"]');
    const aTd = tr.querySelector('.item-amt');
    if (!qInp || !pInp || !aTd) return;
    const q = qInp.disabled ? 0 : (Number(qInp.value) || 0);
    const p = pInp.disabled ? 0 : (Number(pInp.value) || 0);
    const row = q * p;
    aTd.textContent = row ? currencySymbol() + row.toFixed(2) : '-';
    sum += row;
  });
  const wrap = tb.closest('.item-wrap');
  const sumEl = wrap && wrap.querySelector('.item-sum');
  if (sumEl) sumEl.textContent = '合计：' + currencySymbol() + sum.toFixed(2);
  const amt = tb.closest('form') && tb.closest('form').querySelector('[name="amount"]');
  if (amt){
    amt.value = sum ? sum.toFixed(2) : '';
    amt.readOnly = tb.rows.length > 0;
  }
}
function collectItems(tb){
  if (!tb) return null;
  const arr = [];
  [...tb.rows].forEach(tr => {
    const nameInp = tr.querySelector('[data-f="name"]');
    const name = (nameInp && nameInp.value || '').trim();
    if (!name) return;
    const modelInp = tr.querySelector('[data-f="model"]');
    const model = (modelInp && modelInp.value || '').trim();
    const free = (tr.querySelector('[data-f="free"]') || {}).checked;
    if (free){ arr.push(model ? { name, model } : { name }); return; }
    const q = Number(tr.querySelector('[data-f="qty"]').value) || 0;
    const p = Number(tr.querySelector('[data-f="price"]').value) || 0;
    if (q <= 0 || p <= 0) return; /* 缺数量或单价的行不入明细 */
    const it = { name, qty: q, price: Math.round(fromDisplayMoney(p) * 100) / 100 };
    if (model) it.model = model;
    arr.push(it);
  });
  return arr.length ? arr : null;
}
function fmtItems(items){
  if (!Array.isArray(items) || !items.length) return '';
  const rows = items.map(it => {
    const model = it.model ? `<div class="text-muted" style="font-size:12px">型号：${esc(it.model)}</div>` : '';
    if (it.qty == null && it.price == null){
      return `<tr class="text-muted"><td colspan="3" style="word-break:break-all">${esc(it.name)}${model}</td><td class="text-end">说明</td></tr>`;
    }
    return `<tr><td style="word-break:break-all">${esc(it.name)}${model}</td><td class="text-nowrap">${it.qty}</td><td class="text-nowrap">${money(it.price)}</td>
      <td class="text-end text-nowrap">${money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td></tr>`;
  }).join('');
  const total = items.reduce((s, it) => s + ((Number(it.qty) || 0) * (Number(it.price) || 0)), 0);
  return `<table class="table table-sm table-bordered mt-1 mb-1" style="max-width:100%">
    <thead class="table-light"><tr><th style="min-width:120px">商品</th><th style="width:60px">数量</th><th style="width:96px">单价(${currencySymbol()})</th><th class="text-end" style="width:96px">金额</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="fw-bold"><td colspan="3">合计</td><td class="text-end">${money(total)}</td></tr></tfoot>
    </table>`;
}

/* 图片上传：转 base64 → /api/upload（jpg/png/webp ≤2MB）→ 回填 hidden 并预览 */
async function uploadPhoto(input, hidden, preview){
  const f = input.files && input.files[0];
  if (!f) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)){ alert('仅支持 jpg / png / webp 图片'); input.value = ''; return; }
  if (f.size > 2 * 1024 * 1024){ alert('图片不能超过 2MB'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const r = await api('/api/upload', 'POST', { data: reader.result });
      hidden.value = r.url;
      preview.src = r.url;
      preview.style.display = '';
    } catch(e){ alert(e.message); input.value = ''; }
  };
  reader.readAsDataURL(f);
}

function openActions(title, items){
  const mid = 'ac' + Date.now();
  const html = `<div class="modal fade" id="${mid}"><div class="modal-dialog modal-dialog-centered modal-sm">
    <div class="modal-content">
      <div class="modal-header py-2"><h6 class="modal-title">${esc(title)}</h6>
        <button class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body d-grid gap-2">
        ${items.map((it, i) => `<button class="btn btn-sm ${it.cls || 'btn-outline-primary'}" data-i="${i}">${esc(it.label)}</button>`).join('')}
      </div>
    </div></div></div>`;
  $('#modalHost').insertAdjacentHTML('beforeend', html);
  const el = document.getElementById(mid);
  const modal = new bootstrap.Modal(el);
  el.querySelectorAll('[data-i]').forEach(btn => {
    btn.onclick = () => { modal.hide(); items[Number(btn.dataset.i)].fn(); };
  });
  el.addEventListener('hidden.bs.modal', () => el.remove());
  modal.show();
}

function openInfo(title, bodyHtml, width){
  const mid = 'in' + Date.now();
  const html = `<div class="modal fade" id="${mid}"><div class="modal-dialog modal-dialog-centered ${width || ''}">
    <div class="modal-content">
      <div class="modal-header py-2"><h6 class="modal-title">${esc(title)}</h6>
        <button class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer py-2">
        <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">关闭</button>
      </div>
    </div></div></div>`;
  $('#modalHost').insertAdjacentHTML('beforeend', html);
  const el = document.getElementById(mid);
  const modal = new bootstrap.Modal(el);
  el.addEventListener('hidden.bs.modal', () => el.remove());
  modal.show();
}

