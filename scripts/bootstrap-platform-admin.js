'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createPlatformPool } = require('../server/platform-db');
const { hashPassword } = require('../server/util');
const { encodeBase32, hashRecoveryCode, RECOVERY_CODE_COUNT } = require('../services/platform-api/mfa');

const LOCK_NAME = 'house-management-platform-admin-bootstrap-v1';
const PERMISSIONS = Object.freeze([
  'platform:read', 'platform:admins:write', 'tenants:read', 'tenants:write',
  'plans:read', 'plans:write', 'billing:read', 'billing:write'
]);

function validateInput({ username, password, mfaEncryption, recoveryCodePepper }) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,80}$/.test(username)) {
    throw new TypeError('PLATFORM_BOOTSTRAP_USERNAME_INVALID');
  }
  if (typeof password !== 'string' || password.length < 16 || password.length > 256 ||
      /[\x00-\x1f\x7f]/.test(password)) {
    throw new TypeError('PLATFORM_BOOTSTRAP_PASSWORD_POLICY_FAILED');
  }
  if (!mfaEncryption || typeof mfaEncryption.encrypt !== 'function') {
    throw new TypeError('PLATFORM_BOOTSTRAP_MFA_ENCRYPTION_REQUIRED');
  }
  if (!(typeof recoveryCodePepper === 'string' || Buffer.isBuffer(recoveryCodePepper)) ||
      Buffer.byteLength(recoveryCodePepper) < 32) {
    throw new TypeError('PLATFORM_BOOTSTRAP_RECOVERY_PEPPER_REQUIRED');
  }
}

async function bootstrapFirstPlatformAdmin({
  pool, username, password, mfaEncryption, recoveryCodePepper,
  randomBytes = crypto.randomBytes,
  passwordHasher = hashPassword
}) {
  validateInput({ username, password, mfaEncryption, recoveryCodePepper });
  if (!pool || typeof pool.getConnection !== 'function' ||
      typeof now !== 'function' || typeof randomBytes !== 'function' ||
      typeof passwordHasher !== 'function') {
    throw new TypeError('PLATFORM_BOOTSTRAP_DEPENDENCIES_INVALID');
  }
  const connection = await pool.getConnection();
  let lockAcquired = false;
  let inTransaction = false;
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 15) AS acquired', [LOCK_NAME]);
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw Object.assign(new Error('PLATFORM_BOOTSTRAP_LOCK_UNAVAILABLE'), {
        code: 'PLATFORM_BOOTSTRAP_LOCK_UNAVAILABLE', status: 503
      });
    }
    lockAcquired = true;
    await connection.beginTransaction();
    inTransaction = true;
    const [rows] = await connection.query('SELECT COUNT(*) AS total FROM platform_admins');
    if (Number(rows[0]?.total) !== 0) {
      throw Object.assign(new Error('PLATFORM_BOOTSTRAP_ALREADY_COMPLETED'), {
        code: 'PLATFORM_BOOTSTRAP_ALREADY_COMPLETED', status: 409
      });
    }

    const secret = randomBytes(20);
    if (!Buffer.isBuffer(secret) || secret.length !== 20) {
      throw new Error('PLATFORM_BOOTSTRAP_RANDOM_SOURCE_INVALID');
    }
    let encryptedSecret;
    let recoveryCodes;
    try {
      encryptedSecret = await mfaEncryption.encrypt(secret);
      if (!encryptedSecret || typeof encryptedSecret !== 'object' || Array.isArray(encryptedSecret)) {
        throw new Error('PLATFORM_BOOTSTRAP_ENCRYPTION_FAILED');
      }
      const passwordHash = passwordHasher(password);
      const [inserted] = await connection.query(
        'INSERT INTO platform_admins (username, password_hash, mfa_required, status, permissions_json) VALUES (?, ?, 1, \'active\', ?)',
        [username, passwordHash, JSON.stringify(PERMISSIONS)]
      );
      const adminId = Number(inserted.insertId);
      if (!Number.isSafeInteger(adminId) || adminId < 1) throw new Error('PLATFORM_BOOTSTRAP_ADMIN_CREATE_FAILED');

      await connection.query(
        'INSERT INTO platform_admin_mfa_factors (admin_id, encrypted_secret, enabled, last_totp_counter) VALUES (?, ?, 1, 0)',
        [adminId, JSON.stringify(encryptedSecret)]
      );
      recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
        const raw = randomBytes(6);
        if (!Buffer.isBuffer(raw) || raw.length !== 6) throw new Error('PLATFORM_BOOTSTRAP_RANDOM_SOURCE_INVALID');
        try {
          const value = raw.toString('hex').toUpperCase();
          return value.slice(0, 4) + '-' + value.slice(4, 8) + '-' + value.slice(8, 12);
        } finally { raw.fill(0); }
      });
      const hashes = recoveryCodes.map(code => hashRecoveryCode(code, recoveryCodePepper));
      for (const codeHash of hashes) {
        await connection.query(
          'INSERT INTO platform_admin_mfa_recovery_codes (admin_id, code_hash) VALUES (?, ?)',
          [adminId, codeHash]
        );
      }
      await connection.query(
        'INSERT INTO platform_admin_audit_events (admin_id, action, outcome, detail_code) VALUES (?, ?, ?, ?)',
        [adminId, 'admin.bootstrap', 'success', 'FIRST_ADMIN_CREATED']
      );
      await connection.commit();
      inTransaction = false;
      return Object.freeze({
        adminId,
        username,
        totpSecret: encodeBase32(secret),
        recoveryCodes: Object.freeze(recoveryCodes)
      });
    } finally {
      secret.fill(0);
    }
  } catch (error) {
    if (inTransaction) {
      try { await connection.rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try { await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch (_) { /* connection release also drops the lock */ }
    }
    connection.release();
  }
}

function readHidden(prompt, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('PLATFORM_BOOTSTRAP_REQUIRES_INTERACTIVE_TTY'));
      return;
    }
    output.write(prompt);
    let value = '';
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };
    const onData = chunk => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cleanup();
          output.write('\n');
          reject(new Error('PLATFORM_BOOTSTRAP_CANCELLED'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32 && byte <= 126 && value.length < 256) value += String.fromCharCode(byte);
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('PLATFORM_BOOTSTRAP_REQUIRES_INTERACTIVE_TTY');
  }
  const username = await new Promise((resolve, reject) => {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('First Platform Admin username: ', value => { rl.close(); resolve(value); });
    rl.on('SIGINT', () => { rl.close(); reject(new Error('PLATFORM_BOOTSTRAP_CANCELLED')); });
  });
  const password = await readHidden('Password (16+ chars, hidden): ');
  const confirmation = await readHidden('Confirm password (hidden): ');
  if (password !== confirmation) throw new Error('PLATFORM_BOOTSTRAP_PASSWORD_MISMATCH');

  const providerPath = process.env.PLATFORM_SECURITY_PROVIDER_MODULE;
  if (!providerPath || !path.isAbsolute(providerPath)) {
    throw new Error('PLATFORM_SECURITY_PROVIDER_MODULE_ABSOLUTE_PATH_REQUIRED');
  }
  const provider = require(providerPath);
  if (!provider || typeof provider.createBootstrapDependencies !== 'function') {
    throw new Error('PLATFORM_SECURITY_PROVIDER_MODULE_INVALID');
  }
  const dependencies = await provider.createBootstrapDependencies({ env: process.env });
  const pool = createPlatformPool();
  try {
    const result = await bootstrapFirstPlatformAdmin({
      pool, username, password,
      mfaEncryption: dependencies.mfaEncryption,
      recoveryCodePepper: dependencies.recoveryCodePepper
    });
    process.stdout.write('\nFirst Platform Admin created. Save the following once in your password manager.\n');
    process.stdout.write('Admin ID: ' + result.adminId + '\n');
    process.stdout.write('TOTP secret: ' + result.totpSecret + '\n');
    process.stdout.write('Recovery codes (each is single-use):\n' + result.recoveryCodes.join('\n') + '\n');
    process.stdout.write('The TOTP secret and recovery codes will not be shown again.\n');
  } finally {
      if (typeof pool.end === 'function') await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write((error.code || error.message || 'PLATFORM_BOOTSTRAP_FAILED') + '\n');
    process.exitCode = 1;
  });
}

module.exports = { LOCK_NAME, PERMISSIONS, bootstrapFirstPlatformAdmin, readHidden };
