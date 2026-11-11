const root = document.documentElement;
const appId = root.dataset.appId;
const healthPath = document.querySelector('meta[name="api-health"]')?.content || '/health/live';
const status = document.getElementById('api-status');
const message = document.getElementById('service-message');
const dot = document.getElementById('api-dot');
async function checkApi() {
  try {
    const response = await fetch(healthPath, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { 'accept': 'application/json' } });
    if (!response.ok) throw new Error('HTTP_' + response.status);
    const body = await response.json();
    if (body.service !== appId + '-api' && body.service !== 'platform-api') throw new Error('API_ID_MISMATCH');
    status.textContent = 'API 已连接';
    message.textContent = appId + ' API 健康检查通过。业务会话与数据接口仍需独立认证接入。';
    dot.classList.add('ok');
  } catch (error) {
    status.textContent = 'API 未连接';
    message.textContent = '无法连接 ' + appId + ' API。请确认该应用独立部署的 API 地址和健康检查路由。';
    dot.classList.remove('ok');
  }
}
checkApi();
