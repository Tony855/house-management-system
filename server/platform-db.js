'use strict';

const mysql = require('mysql2/promise');

/**
 * Dedicated platform-control-plane pool.
 * It intentionally has no fallback to DB_NAME, the legacy shared DB, or a tenant DB.
 */
function createPlatformPool({ env = process.env, createPool = mysql.createPool } = {}) {
  const host = env.PLATFORM_DB_HOST;
  const database = env.PLATFORM_DB_NAME;
  const user = env.PLATFORM_DB_USER;
  const password = env.PLATFORM_DB_PASSWORD;
  const port = Number(env.PLATFORM_DB_PORT || 3306);
  if (!host || !database || !user || !password) throw new Error('PLATFORM_DATABASE_CONFIGURATION_REQUIRED');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('PLATFORM_DATABASE_NAME_INVALID');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PLATFORM_DATABASE_PORT_INVALID');
  const connectionLimit = Number(env.PLATFORM_DB_POOL_SIZE || 10);
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 100) throw new Error('PLATFORM_DATABASE_POOL_SIZE_INVALID');
  const queueLimit = env.PLATFORM_DB_QUEUE_LIMIT === undefined ? 100 : Number(env.PLATFORM_DB_QUEUE_LIMIT);
  if (!Number.isInteger(queueLimit) || queueLimit < 1 || queueLimit > 10000) throw new Error('PLATFORM_DATABASE_QUEUE_LIMIT_INVALID');
  const connectTimeout = env.PLATFORM_DB_CONNECT_TIMEOUT_MS === undefined ? 10000 : Number(env.PLATFORM_DB_CONNECT_TIMEOUT_MS);
  if (!Number.isInteger(connectTimeout) || connectTimeout < 1000 || connectTimeout > 60000) throw new Error('PLATFORM_DATABASE_CONNECT_TIMEOUT_INVALID');
  return createPool({
    host, port, database, user, password,
    charset: 'utf8mb4', waitForConnections: true,
    connectionLimit, queueLimit, connectTimeout,
    enableKeepAlive: true, keepAliveInitialDelay: 0,
    decimalNumbers: false, dateStrings: true
  });
}

module.exports = { createPlatformPool };
