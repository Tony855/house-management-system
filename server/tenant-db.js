'use strict';

const crypto = require('crypto');
const IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_IDS = new Set(['rental', 'hotel', 'property']);

class TenantPoolManager {
  constructor({ createPool, maxPools = 100, idleTtlMs = 5 * 60 * 1000, now = Date.now }) {
    if (typeof createPool !== 'function') throw new TypeError('createPool is required');
    if (!Number.isInteger(maxPools) || maxPools < 1 || maxPools > 500) throw new TypeError('TENANT_POOL_MAX_INVALID');
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1 || idleTtlMs > 86400000) throw new TypeError('TENANT_POOL_IDLE_TTL_INVALID');
    if (typeof now !== 'function') throw new TypeError('TENANT_POOL_CLOCK_INVALID');
    this.createPool = createPool;
    this.maxPools = maxPools;
    this.idleTtlMs = idleTtlMs;
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
    this.tenantEpoch = new Map();
    this.creationQueue = Promise.resolve();
  }

  _key(context) {
    if (!context || !context.tenantId || !context.appId || !context.db) throw new Error('TENANT_CONTEXT_REQUIRED');
    if (!APP_IDS.has(context.appId) || typeof context.tenantId !== 'string' || !UUID_RE.test(context.tenantId)) throw new Error('TENANT_CONTEXT_INVALID');
    if (typeof context.db.database !== 'string' || !IDENTIFIER_RE.test(context.db.database)) throw new Error('TENANT_DATABASE_IDENTIFIER_INVALID');
    if (typeof context.db.host !== 'string' || !context.db.host || context.db.host.length > 253 || /[\s\u0000-\u001f]/.test(context.db.host)) {
      throw new Error('TENANT_DATABASE_HOST_INVALID');
    }
    if (!Number.isInteger(context.db.port) || context.db.port < 1 || context.db.port > 65535) {
      throw new Error('TENANT_DATABASE_PORT_INVALID');
    }
    if (typeof context.db.user !== 'string' || !context.db.user || context.db.user.length > 128) {
      throw new Error('TENANT_DATABASE_USER_INVALID');
    }
    if (typeof context.db.password !== 'string' || !context.db.password || context.db.password.length > 1024) {
      throw new Error('TENANT_DATABASE_PASSWORD_INVALID');
    }
    if (context.db.credentialVersion !== undefined &&
        (typeof context.db.credentialVersion !== 'string' || context.db.credentialVersion.length > 128)) {
      throw new Error('TENANT_DATABASE_CREDENTIAL_VERSION_INVALID');
    }
    const credentialFingerprint = crypto.createHash('sha256').update(context.db.password).digest('hex');
    return JSON.stringify([context.appId, context.tenantId, context.db.host.toLowerCase(), context.db.port, context.db.database, context.db.user, context.db.credentialVersion || '', credentialFingerprint]);
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
    const cached = this.entries.get(key);
    if (cached && cached.lastUsedAt > this.now() - this.idleTtlMs) {
      cached.lastUsedAt = this.now();
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.pool;
    }
    if (this.pending.has(key)) return this.pending.get(key).promise;

    // Reserve the key synchronously before the first await. This makes closeAll()
    // and concurrent callers observe the in-flight operation immediately.
    const epoch = this.tenantEpoch.get(context.tenantId) || 0;
    const pending = { tenantId: context.tenantId, promise: null };
    pending.promise = Promise.resolve().then(async () => {
      await this._evictExpired();
      const existing = this.entries.get(key);
      if (existing) {
        existing.lastUsedAt = this.now();
        return existing.pool;
      }
      // A changed password produces a new key; retire older pools for this tenant.
      for (const [oldKey, oldEntry] of this.entries) {
        if (oldEntry.tenantId === context.tenantId && oldKey !== key) {
          this.entries.delete(oldKey);
          await this._close(oldEntry);
        }
      }
      return this._createPool(context, key, epoch);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending.promise;
  }

  async _createPool(context, key, epoch) {
    const create = async () => {
      if ((this.tenantEpoch.get(context.tenantId) || 0) !== epoch) throw new Error('TENANT_POOL_INVALIDATED');
      while (this.entries.size >= this.maxPools) {
        const oldestKey = this.entries.keys().next().value;
        const oldest = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        await this._close(oldest);
        if ((this.tenantEpoch.get(context.tenantId) || 0) !== epoch) throw new Error('TENANT_POOL_INVALIDATED');
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
      if (!pool || typeof pool.end !== 'function') throw new TypeError('TENANT_POOL_ADAPTER_INVALID');
      if ((this.tenantEpoch.get(context.tenantId) || 0) !== epoch) {
        await this._close({ pool });
        throw new Error('TENANT_POOL_INVALIDATED');
      }
      this.entries.set(key, { pool, lastUsedAt: this.now(), tenantId: context.tenantId });
      return pool;
    };
    // Serialize capacity checks and inserts so concurrent tenants cannot exceed maxPools.
    const run = this.creationQueue.then(create);
    this.creationQueue = run.then(() => undefined, () => undefined);
    return run;
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
    const pending = Array.from(this.pending.values());
    const tenantIds = new Set([...this.entries.values()].map(entry => entry.tenantId));
    for (const item of pending) tenantIds.add(item.tenantId);
    for (const tenantId of tenantIds) this.tenantEpoch.set(tenantId, (this.tenantEpoch.get(tenantId) || 0) + 1);
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.all(entries.map(entry => this._close(entry)));
    await Promise.all(pending.map(item => item.promise.catch(() => {})));
  }

  get size() { return this.entries.size; }
}

module.exports = { TenantPoolManager };
