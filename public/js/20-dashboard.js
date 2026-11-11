'use strict';
/* ==================================================================
 *  8. 仪表盘（三模式）
 * ================================================================== */
async function renderDashboard(){
  const s = await api('/api/stats');
  const mode = curMode();

  let cards, tables;

  if (mode === 'rental'){
    cards = [
      ['总房间数', s.total_rooms, 'door-open', 'primary'],
      ['已出租', s.rented, 'check-circle', 'success'],
      ['空置', s.vacant, 'dash-circle', 'secondary'],
      ['入住率', s.occupancy + '%', 'graph-up-arrow', 'info'],
      ['本月应收', money(s.month_receivable), 'wallet2', 'warning'],
      ['本月已收', money(s.month_received), 'cash-coin', 'success'],
      ['累计欠费', money(s.arrears), 'exclamation-triangle', 'danger'],
      ['待处理报修', s.pending_repairs, 'tools', 'danger']
    ];
    tables = `
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-white fw-bold">
            <i class="bi bi-alarm text-danger"></i> 30 天内到期合同（${s.expiring.length}）</div>
          <div class="table-responsive" style="max-height:320px">
            <table class="table table-hover mb-0">
              <thead class="table-light"><tr>
                <th>房间</th><th>租客</th><th>电话</th><th>到期日</th><th>剩余</th></tr></thead>
              <tbody>
                ${s.expiring.map(e => `<tr>
                  <td>${esc(e.building_name)} ${esc(e.room_no)}</td>
                  <td>${esc(e.tenant_name)}</td>
                  <td>${esc(e.phone || '-')}</td>
                  <td class="text-danger">${e.end_date}</td>
                  <td><span class="badge bg-${e.days_left <= 7 ? 'danger' : 'warning text-dark'}">${e.days_left} 天</span></td>
                </tr>`).join('') || '<tr><td colspan="5" class="text-center text-muted py-4">暂无即将到期合同</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-white fw-bold"><i class="bi bi-receipt"></i> 最近账单</div>
          <div class="table-responsive" style="max-height:320px">
            <table class="table table-hover mb-0">
              <thead class="table-light"><tr>
                <th>房间</th><th>租客</th><th>金额</th><th>状态</th></tr></thead>
              <tbody>
                ${s.recent_bills.map(b => `<tr>
                  <td>${esc(b.room_no || '-')}</td>
                  <td>${esc(b.tenant_name || '-')}</td>
                  <td>${money(b.amount)}</td>
                  <td>${billBadge(b.status)}</td>
                </tr>`).join('') || '<tr><td colspan="4" class="text-center text-muted py-4">暂无账单</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
  }

  else if (mode === 'hotel'){
    cards = [
      ['房间总数', s.total_rooms, 'door-open', 'primary'],
      ['空闲', s.vacant, 'dash-circle', 'secondary'],
      ['已入住', s.rented, 'person-check', 'success'],
      ['已预订', s.booked, 'calendar-check', 'info'],
      ['今日入住', s.today_checkin, 'box-arrow-in-right', 'primary'],
      ['今日退房', s.today_checkout, 'box-arrow-right', 'warning'],
      ['今日营收', money(s.today_revenue), 'cash-coin', 'success'],
      ['待处理报修', s.pending_repairs, 'tools', 'danger']
    ];
    tables = `
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-white fw-bold">
            <i class="bi bi-journal-check text-primary"></i> 最近订单</div>
          <div class="table-responsive" style="max-height:320px">
            <table class="table table-hover mb-0">
              <thead class="table-light"><tr>
                <th>房间</th><th>房客</th><th>入离</th><th>金额</th><th>状态</th></tr></thead>
              <tbody>
                ${s.recent_orders.map(o => `<tr>
                  <td>${esc(o.building_name || '')} ${esc(o.room_no || '')}</td>
                  <td>${esc(o.guest_name)}</td>
                  <td><small>${o.check_in_date} ~ ${o.check_out_date}</small></td>
                  <td>${money(o.total)}</td>
                  <td>${orderBadge(o.status)}</td>
                </tr>`).join('') || '<tr><td colspan="5" class="text-center text-muted py-4">暂无订单</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-white fw-bold">
            <i class="bi bi-stars text-warning"></i> 待清洁房间（${s.dirty_rooms.length}）</div>
          <div class="table-responsive" style="max-height:320px">
            <table class="table table-hover mb-0">
              <thead class="table-light"><tr>
                <th>楼栋</th><th>房间号</th><th>房型</th><th>操作</th></tr></thead>
              <tbody>
                ${s.dirty_rooms.map(r => `<tr>
                  <td>${esc(r.building_name)}</td>
                  <td><b>${esc(r.room_no)}</b></td>
                  <td>${esc(r.room_type || '-')}</td>
                  <td><button class="btn btn-sm btn-outline-success"
                        onclick="finishClean(${r.id})">清洁完成</button></td>
                </tr>`).join('') || '<tr><td colspan="4" class="text-center text-muted py-4">暂无待清洁房间</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
  }

  else {
    cards = [
      ['总户数', s.total_rooms, 'houses', 'primary'],
      ['企业数', s.owner_count, 'building', 'info'],
      ['企业员工数', s.emp_count, 'person-vcard', 'success'],
      ['本月应收物业费', money(s.property_receivable), 'wallet2', 'warning'],
      ['本月已收', money(s.property_received), 'cash-coin', 'success'],
      ['当月收缴率', s.pay_rate + '%', 'graph-up-arrow', 'success'],
      ['累计欠费', money(s.property_arrears + s.net_arrears), 'exclamation-triangle', 'danger'],
      ['本月网费', money(s.net_receivable), 'ethernet', 'primary'],
      ['待处理投诉', s.pending_complaints, 'chat-square-text', 'danger']
    ];
    tables = `
    <div class="row g-3 mb-3">
      <div class="col-lg-4">
        <div class="card h-100"><div class="card-body">
          <h6 class="fw-bold mb-3"><i class="bi bi-lightning-charge text-primary"></i>
            本月 ${curMonth()} 费用汇总</h6>
          <div class="d-flex justify-content-between mb-2">
            <span class="text-muted">本月网费预估</span>
            <b class="text-primary">${money(s.net_estimate_month)}</b>
          </div>
          <div class="d-flex justify-content-between mb-2">
            <span class="text-muted">总带宽</span>
            <b>${s.total_bandwidth} 兆</b>
          </div>
          <div class="d-flex justify-content-between mb-2">
            <span class="text-muted">本月带宽变更</span>
            <b>${s.net_change_month} 次</b>
          </div>
          <hr class="my-2">
          <div class="d-flex justify-content-between mb-2">
            <span class="text-muted">水费</span>
            <b>${money(s.meter_water_fee)}</b>
            <small class="text-muted">${s.meter_water_usage} 吨</small>
          </div>
          <div class="d-flex justify-content-between mb-2">
            <span class="text-muted">电费</span>
            <b>${money(s.meter_elec_fee)}</b>
            <small class="text-muted">${s.meter_elec_usage} 度</small>
          </div>
          <div class="d-flex justify-content-between">
            <span class="text-muted">网费欠收</span>
            <b class="text-danger">${money(s.net_arrears)}</b>
          </div>
        </div></div>
      </div>
      <div class="col-lg-8">
        <div class="card h-100">
          <div class="card-header bg-white fw-bold">
            <i class="bi bi-exclamation-triangle text-danger"></i> 欠费明细（${s.arrears_rooms.length} 户）</div>
          <div class="table-responsive" style="max-height:220px">
            <table class="table table-hover mb-0">
              <thead class="table-light"><tr>
                <th>房间</th><th>企业</th><th>电话</th>
                <th>物业欠费</th><th>网费欠费</th><th>合计</th></tr></thead>
              <tbody>
                ${s.arrears_rooms.map(r => `<tr>
                  <td>${esc(r.building_name)} ${esc(r.room_no)}</td>
                  <td>${esc(r.owner_name || '-')}</td>
                  <td>${esc(r.owner_phone || '-')}</td>
                  <td>${r.owe_property > 0 ? money(r.owe_property) : '-'}</td>
                  <td>${r.owe_network > 0 ? money(r.owe_network) : '-'}</td>
                  <td class="text-danger fw-bold">${money(r.owe)}</td>
                </tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted py-4">暂无欠费</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header bg-white fw-bold">
        <i class="bi bi-chat-square-text text-primary"></i> 最近投诉建议</div>
      <div class="table-responsive" style="max-height:300px">
        <table class="table table-hover mb-0">
          <thead class="table-light"><tr>
            <th>房间</th><th>企业</th><th>类型</th><th>标题</th><th>状态</th></tr></thead>
          <tbody>
            ${s.recent_complaints.map(c => `<tr>
              <td>${esc(c.building_name || '')} ${esc(c.room_no || '-')}</td>
              <td>${esc(c.owner_name || '-')}</td>
              <td><span class="badge bg-light text-dark">${esc(c.type)}</span></td>
              <td>${esc(c.title)}</td>
              <td>${complaintBadge(c.status)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="text-center text-muted py-4">暂无记录</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  const cardHtml = cards.map(c => `
    <div class="col-6 col-md-3">
      <div class="card stat-card"><div class="card-body py-3">
        <div class="d-flex justify-content-between align-items-center">
          <div>
            <div class="text-muted small">${c[0]}</div>
            <div class="num text-${c[3]}">${c[1]}</div>
          </div>
          <i class="bi bi-${c[2]} fs-2 text-${c[3]} opacity-50"></i>
        </div>
      </div></div>
    </div>`).join('');

  $('#page').innerHTML = `<div class="row g-3 mb-4">${cardHtml}</div>${tables}`;
}

async function finishClean(roomId){
  try { await api('/api/rooms/' + roomId, 'PUT', { status:'vacant' }); renderDashboard(); }
  catch(e){ alert(e.message); }
}

