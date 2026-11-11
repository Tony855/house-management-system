'use strict';

const crypto = require('crypto');
const IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;

class TenantPoolManager {
  constructor({ createPool, maxPools = 100, idleTtlMs = 5 * 60 * 1000, now = Date.now }) {
    if (typeof createPool !== 'function') throw new TypeError('createPool is required');
    if (!Number.isInteger(maxPools) || maxPools < 1) throw new TypeError('maxPools must be positive');
    this.createPool = createPool;
    this.maxPools = maxPools;
    this.idleTtlMs = idleTtlMs;
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
    this.tenantEpoch = new Map();
  }

  _key(context) {
    if (!context || !context.tenantId || !context.appId || !context.db) throw new Error('TENANT_CONTEXT_REQUIRED');
    if (!IDENTIFIER_RE.test(context.db.database)) throw new Error('TENANT_DATABASE_IDENTIFIER_INVALID');
    if (!context.db.host || !context.db.user || typeof context.db.password !== 'string' || !context.db.password) {
      throw new Error('TENANT_DATABASE_CREDENTIALS_INVALID');
    }
    const credentialFingerprint = crypto.createHash('sha256').update(context.db.password).digest('hex');
    return [context.appId, context.tenantId, context.db.host, context.db.port, context.db.database, context.db.user, context.db.credentialVersion || '', credentialFingerprint].join(':');
  }

  async _close(entry) {
    try { await entry.pool.end(); } catch (_) { /* best-effort close; never leak credentials */ }
  }

  async _evictExpired() {
    const cutoff = this.now() - this.idleTtlMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt <= cutoff) {
        this.entries.delete(key);
        await this._close(entry);
      }
    }
  }

  async getPool(context) {
    const key = this._key(context);
    await this._evictExpired();
    let entry = this.entries.get(key);
    if (entry) {
      entry.lastUsedAt = this.now();
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.pool;
    }
    if (this.pending.has(key)) return this.pending.get(key).promise;
    // A changed password produces a new key; retire older pools for this tenant immediately.
    for (const [oldKey, oldEntry] of this.entries) {
      if (oldEntry.tenantId === context.tenantId && oldKey !== key) {
        this.entries.delete(oldKey);
        await this._close(oldEntry);
      }
    }
    const epoch = this.tenantEpoch.get(context.tenantId) || 0;
    const pending = { tenantId: context.tenantId, promise: null };
    pending.promise = this._createPool(context, key, epoch).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending.promise;
  }

  async _createPool(context, key, epoch) {
    while (this.entries.size >= this.maxPools) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      await this._close(oldest);
    }
    const pool = this.createPool({
      host: context.db.host,
      port: context.db.port,
      user: context.db.user,
      password: context.db.password,
      database: context.db.database,
      charset: 'utf8mb4',
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 50
    });
    if ((this.tenantEpoch.get(context.tenantId) || 0) !== epoch) {
      await this._close({ pool });
      throw new Error('TENANT_POOL_INVALIDATED');
    }
    this.entries.set(key, { pool, lastUsedAt: this.now(), tenantId: context.tenantId });
    return pool;
  }

  async closeTenant(tenantId) {
    this.tenantEpoch.set(tenantId, (this.tenantEpoch.get(tenantId) || 0) + 1);
    const pending = [...this.pending.values()].filter(item => item.tenantId === tenantId);
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === tenantId) {
        this.entries.delete(key);
        await this._close(entry);
      }
    }
    await Promise.all(pending.map(item => item.promise.catch(() => {})));
  }

  async closeAll() {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.all(entries.map(entry => this._close(entry)));
  }

  get size() { return this.entries.size; }
}

module.exports = { TenantPoolManager };
