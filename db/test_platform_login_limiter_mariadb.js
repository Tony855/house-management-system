'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createPlatformLoginRateLimiter } = require('../server/platform-adapters');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'platform_control_test',
    connectionLimit: 4,
    waitForConnections: true,
    timezone: 'Z'
  });
  const identity = {
    appId: 'rental',
    host: 'ci-' + crypto.randomUUID() + '.example.test',
    username: 'ci-' + crypto.randomUUID()
  };
  const limiter = createPlatformLoginRateLimiter(pool, {
    hmacKey: 'ci-only-hmac-key-material-at-least-32-bytes',
    maxAttempts: 3,
    windowSeconds: 900,
    blockSeconds: 900
  });

  try {
    assert.equal(await limiter.assertAllowed(identity), true);
    await Promise.all([
      limiter.recordFailure(identity),
      limiter.recordFailure(identity),
      limiter.recordFailure(identity)
    ]);
    await assert.rejects(
      limiter.assertAllowed(identity),
      error => error.code === 'LOGIN_RATE_LIMITED' && error.status === 429
    );
    await limiter.clear(identity);
    assert.equal(await limiter.assertAllowed(identity), true);
    console.log('Platform login rate limiter MariaDB integration passed (concurrent failures, lockout, clear).');
  } finally {
    await limiter.clear(identity).catch(() => {});
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
