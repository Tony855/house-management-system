const root = document.documentElement;
const appId = root.dataset.appId;
const healthPath = document.querySelector('meta[name="api-health"]')?.content || '/health/live';
const status = document.getElementById('api-status');
const message = document.getElementById('service-message');
const dot = document.getElementById('api-dot');
const empty = document.getElementById('service-empty');
let accessToken = null;
let challenge = null;

function setStatus(label, healthy) {
  status.textContent = label;
  dot.classList.toggle('ok', healthy);
}
async function jsonRequest(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = 'Bearer ' + accessToken;
  const response = await fetch(path, { ...options, headers, credentials: 'omit', cache: 'no-store' });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'REQUEST_FAILED');
  return body;
}
function field(labelText, type, autocomplete) {
  const label = document.createElement('label');
  label.className = 'auth-field';
  const caption = document.createElement('span');
  caption.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.autocomplete = autocomplete;
  input.required = true;
  input.maxLength = type === 'password' ? 100 : 80;
  label.append(caption, input);
  return { label, input };
}
function createAuthPanel() {
  if (!empty) return;
  empty.textContent = '';
  empty.classList.add('auth-panel');
  const heading = document.createElement('h3');
  heading.textContent = appId === 'platform' ? '平台管理员安全登录' : '租户账号登录';
  const hint = document.createElement('p');
  hint.textContent = appId === 'platform'
    ? '先验证管理员密码，再完成 MFA 动态验证码。'
    : '登录后仅访问当前产品和当前租户的数据。刷新页面后需要重新登录。';
  const form = document.createElement('form');
  form.className = 'auth-form';
  form.id = 'login-form';
  const username = field('账号', 'text', 'username');
  const password = field('密码', 'password', 'current-password');
  const code = field('MFA 动态验证码', 'text', 'one-time-code');
  code.input.inputMode = 'numeric';
  code.input.maxLength = 12;
  code.label.hidden = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = '登录';
  const feedback = document.createElement('p');
  feedback.className = 'auth-feedback';
  feedback.setAttribute('role', 'status');
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.textContent = '退出登录';
  logout.hidden = true;
  logout.className = 'auth-secondary';
  form.append(username.label, password.label, code.label, submit, logout, feedback);
  empty.append(heading, hint, form);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = '';
    try {
      if (appId === 'platform' && challenge === null) {
        const result = await jsonRequest('/api/platform/auth/login', {
          method: 'POST', body: JSON.stringify({ username: username.input.value, password: password.input.value })
        });
        if (result.mfaRequired !== true || typeof result.challenge !== 'string') throw new Error('MFA_CHALLENGE_INVALID');
        challenge = result.challenge;
        username.label.hidden = true;
        password.label.hidden = true;
        code.label.hidden = false;
        code.input.focus();
        submit.textContent = '验证 MFA';
        feedback.textContent = '密码验证通过，请输入动态验证码。';
        return;
      }
      if (appId === 'platform') {
        const result = await jsonRequest('/api/platform/auth/mfa/verify', {
          method: 'POST', body: JSON.stringify({ challenge, code: code.input.value })
        });
        accessToken = result.accessToken;
        challenge = null;
      } else {
        const result = await jsonRequest('/api/auth/login', {
          method: 'POST', body: JSON.stringify({ username: username.input.value, password: password.input.value })
        });
        if (typeof result.accessToken !== 'string' || !result.accessToken) throw new Error('LOGIN_RESPONSE_INVALID');
        accessToken = result.accessToken;
      }
      const contextPath = appId === 'platform' ? '/api/platform/auth/mfa/status' : '/api/tenant-context';
      await jsonRequest(contextPath);
      username.label.hidden = true;
      password.label.hidden = true;
      code.label.hidden = true;
      submit.hidden = true;
      logout.hidden = false;
      feedback.textContent = '登录成功。会话令牌只保存在页面内存中，不写入浏览器持久存储。';
      message.textContent = '身份认证通过；工作台只开放已接入并通过权限验证的业务接口。';
      setStatus('已登录 · ' + appId, true);
    } catch (error) {
      accessToken = null;
      feedback.textContent = error.message === 'INVALID_CREDENTIALS' ? '账号或密码错误。' :
        error.message === 'PLATFORM_MFA_REQUIRED' ? '动态验证码无效，请重试。' : '登录未完成：' + error.message;
      if (appId === 'platform' && challenge !== null) code.input.focus();
      else password.input.focus();
    } finally { submit.disabled = false; }
  });

  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      const path = appId === 'platform' ? '/api/platform/auth/logout' : '/api/auth/logout';
      await jsonRequest(path, { method: 'POST' });
      feedback.textContent = '已退出登录。';
    } catch (_) { feedback.textContent = '退出请求未确认；本地会话已清除。'; }
    finally {
      accessToken = null;
      challenge = null;
      form.reset();
      username.label.hidden = false;
      password.label.hidden = false;
      code.label.hidden = true;
      submit.hidden = false;
      logout.hidden = true;
      submit.textContent = '登录';
      logout.disabled = false;
      setStatus('API 已连接 · 未登录', true);
    }
  });
}
async function checkApi() {
  try {
    const body = await jsonRequest(healthPath);
    if (body.service !== appId + '-api' && body.service !== 'platform-api') throw new Error('API_ID_MISMATCH');
    setStatus('API 已连接 · 未登录', true);
    message.textContent = appId + ' API 健康检查通过。请登录以访问受保护的接口。';
  } catch (_) {
    setStatus('API 未连接', false);
    message.textContent = '无法连接 ' + appId + ' API。请确认该应用独立部署的 API 地址和健康检查路由。';
  }
}
createAuthPanel();
checkApi();
