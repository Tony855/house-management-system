'use strict';
/* ==================================================================
 * 轻量输入校验（规则驱动）：任一规则不满足即收集错误，ok() 统一抛出 400
 * 同时承担输入净化（剥离危险 HTML / 控制字符，防存储型 XSS）
 * ================================================================== */

/* 剥离危险内容：控制字符、script 标签、on* 事件属性、javascript: 协议 */
function clean(v) {
  if (typeof v !== 'string') return v;
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .trim();
}

function V(body) {
  body = body || {};
  const errs = [];
  const push = (name, msg) => errs.push(name + ' ' + msg);
  const api = {
    /* 字符串：可选净化/必填/长度上限/枚举/正则 */
    str(name, { required, max, min, enum: en, pattern, def, clean: doClean = true } = {}) {
      let v = body[name];
      if (v === undefined || v === null) v = def;
      if (v === undefined || v === null || v === '') {
        if (required) push(name, '不能为空');
        return v === undefined ? null : v;
      }
      if (typeof v !== 'string') v = String(v);
      if (doClean) v = clean(v);
      if (min !== undefined && v.length < min) push(name, '长度不能少于 ' + min);
      if (max !== undefined && v.length > max) push(name, '长度不能超过 ' + max);
      if (en && !en.includes(v)) push(name, '取值不合法');
      if (pattern && !pattern.test(v)) push(name, '格式不合法');
      return v;
    },
    /* 数值：必填/范围/必须为有限数字 */
    num(name, { required, min, max, def } = {}) {
      let v = body[name];
      if (v === undefined || v === null || v === '') {
        if (v === undefined && def !== undefined) return def;
        if (required) push(name, '不能为空');
        return v === undefined ? null : v;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) { push(name, '必须是数字'); return NaN; }
      if (min !== undefined && n < min) push(name, '不能小于 ' + min);
      if (max !== undefined && n > max) push(name, '不能大于 ' + max);
      return n;
    },
    /* 整数 */
    int(name, opts) {
      const n = api.num(name, opts);
      if (Number.isFinite(n)) return Math.round(n);
      return n;
    },
    /* 日期 YYYY-MM-DD 或 YYYY-MM */
    date(name, { required, def } = {}) {
      let v = body[name];
      if (v === undefined || v === null) v = def;
      if (v === undefined || v === null || v === '') {
        if (required) push(name, '不能为空');
        return v === undefined ? null : v;
      }
      const s = String(v);
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(s)) push(name, '日期格式不合法');
      return s;
    },
    /* 任意数组（校验后逐项清理字符串） */
    arr(name, { required, max, itemMax } = {}) {
      let v = body[name];
      if (v === undefined || v === null) {
        if (required) push(name, '不能为空');
        return v === undefined ? null : v;
      }
      if (!Array.isArray(v)) { push(name, '必须是数组'); return []; }
      if (max !== undefined && v.length > max) push(name, '数量不能超过 ' + max);
      return v.map(x => (typeof x === 'string' && itemMax ? clean(x).slice(0, itemMax) : (typeof x === 'string' ? clean(x) : x)));
    },
    /* 手动检查 */
    check(cond, name, msg) { if (!cond) push(name, msg); },
    ok() {
      if (errs.length) {
        const e = new Error('参数不合法：' + errs.join('；'));
        e.status = 400;
        throw e;
      }
    }
  };
  return api;
}

module.exports = { V, clean };
