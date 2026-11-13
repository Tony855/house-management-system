'use strict';
/* ==================================================================
 * MariaDB 连接池（三模式数据完全隔离）
 * - 共享库 house_sys：settings / roles / users / sessions / user_permissions
 * - 模式库 house_sys_rental / house_sys_hotel / house_sys_property：业务数据
 * 使用方式：
 *   const { shared, getPool } = require('./db');
 *   shared.query(...)            → 共享库
 *   getPool('rental').query(...) → 指定模式库
 * 请求内模式池：认证中间件用 withMode(mode, next) 包裹后，
 *   业务路由中原有的 pool.query(...) 会自动落到该模式的库。
 * ================================================================== */
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');

const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = Number(process.env.DB_PORT) || 3306;
const USER = process.env.DB_USER || 'root';
const PASSWORD = process.env.DB_PASSWORD || '';

function createPool(database) {
  return mysql.createPool({
    host: HOST, port: PORT, user: USER, password: PASSWORD,
    database, charset: 'utf8mb4', dateStrings: true,
    waitForConnections: true, connectionLimit: 10, queueLimit: 0
  });
}

const shared = createPool('house_sys');
const pools = {
  rental:   createPool('house_sys_rental'),
  hotel:    createPool('house_sys_hotel'),
  property: createPool('house_sys_property')
};

const als = new AsyncLocalStorage();

function getPool(mode) {
  if (!Object.prototype.hasOwnProperty.call(pools, mode)) throw new Error('Unsupported database mode: ' + String(mode));
  return pools[mode];
}

/* 在指定模式 + 经营主体上下文内执行 fn（业务路由经此包裹后，pool.query 自动使用该主体所在模式库） */
function withMode(mode, orgId, fn) {
  return als.run({ pool: getPool(mode), mode, orgId: orgId || null }, fn);
}

/* 当前请求上下文的经营主体 id（业务 SQL 据此行级隔离） */
function currentOrgId() {
  const ctx = als.getStore();
  return ctx ? ctx.orgId : null;
}

/* 当前请求上下文的系统模式 */
function currentMode() {
  const ctx = als.getStore();
  return ctx ? ctx.mode : null;
}

/* 模式池门面：请求上下文内自动使用当前模式的库，否则回退共享库 */
const pool = {
  query: (...args) => {
    const ctx = als.getStore();
    return (ctx && ctx.pool ? ctx.pool : shared).query(...args);
  },
  getConnection: (...args) => {
    const ctx = als.getStore();
    return (ctx && ctx.pool ? ctx.pool : shared).getConnection(...args);
  }
};

module.exports = pool;
module.exports.shared = shared;
module.exports.getPool = getPool;
module.exports.withMode = withMode;
module.exports.currentOrgId = currentOrgId;
module.exports.currentMode = currentMode;
module.exports.MODES = ['rental', 'hotel', 'property'];
