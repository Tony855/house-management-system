'use strict';
/* ==================================================================
 * 23. 路由表 & 启动
 * ================================================================== */
const PAGES = {
  home:        { render: renderStaffHome },
  monitor:     { render: renderMonitor },
  fee:         { render: renderFee },
  orgs:        { render: renderOrgs },
  appcfg:      { render: renderAppConfig },
  dashboard:   { render: renderDashboard },
  roommap:     { render: renderRoomMap },
  rooms:       { render: renderRooms },
  properties:  { render: renderRooms },
  tenants:     { render: renderTenants },
  owners:      { render: renderTenants },
  contracts:   { render: renderContracts },
  orders:      { render: renderOrders },
  bills:       { render: renderBills },
  meters:      { render: renderMeters },
  network:     { render: renderNetwork },
  repairs:     { render: renderRepairs },
  complaints:  { render: renderComplaints },
  dorm:        { render: renderDorms },
  buildings:   { render: renderBuildings },
  users:       { render: renderUsers },
  roles:       { render: renderRoles },
  settings:    { render: renderSettings }
};

(async function boot(){
  try {
    const [me, st] = await Promise.all([api('/api/me'), api('/api/settings')]);
    ME = me;
    DB.data.settings = {
      mode: me.mode || 'rental',
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
      remind_days: Number(st.remind_days === undefined ? 3 : st.remind_days)
    };
    renderApp();
  } catch(e){ showLogin(); }
})();
window.addEventListener('hashchange', () => {
  if (!ME){ showLogin(); return; }
  const h = location.hash.slice(1);
  if (PAGES[h]) go(h);
});

