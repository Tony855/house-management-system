'use strict';
/* 通用工具：密码哈希 / 日期运算 */
const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function hashPasswordAsync(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, 32, (error, derived) => {
      if (error) return reject(error);
      return resolve(salt + ':' + derived.toString('hex'));
    });
  });
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2 || !/^[a-f0-9]{16}$/i.test(parts[0]) || !/^[a-f0-9]{64}$/i.test(parts[1])) return false;
  const [salt, hash] = parts;
  const calc = crypto.scryptSync(String(pw), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === calc.length && crypto.timingSafeEqual(expected, calc);
}

function verifyPasswordAsync(pw, stored) {
  if (typeof stored !== 'string') return Promise.resolve(false);
  const parts = stored.split(':');
  if (parts.length !== 2 || !/^[a-f0-9]{16}$/i.test(parts[0]) || !/^[a-f0-9]{64}$/i.test(parts[1])) return Promise.resolve(false);
  const [salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, 32, (error, derived) => {
      if (error) return reject(error);
      return resolve(expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
    });
  });
}

const p2 = n => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function daysBetween(a, b) {
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  return Math.max(1, Math.round((d2 - d1) / 86400000));
}

function daysInMonth(month) { // 'YYYY-MM' -> 当月天数
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function monthStart(dateStr) { return dateStr.slice(0, 7) + '-01'; }

function monthEnd(month) { return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`; }

module.exports = { hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync, today, nowStr, addDays, addMonths, daysBetween, daysInMonth, monthStart, monthEnd };
