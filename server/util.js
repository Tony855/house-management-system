'use strict';
/* 通用工具：密码哈希 / 日期运算 */
const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(calc, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

module.exports = { hashPassword, verifyPassword, today, nowStr, addDays, addMonths, daysBetween, daysInMonth, monthStart, monthEnd };
