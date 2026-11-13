'use strict';

// Parse decimal currency input without binary floating-point multiplication.
// Returns integer minor units or null when the value is not a plain 2dp amount.
function parseMinorUnits(value, { allowZero = false, allowNegative = false, maxMinor = 1000000000 } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value);
  const pattern = allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(text)) return null;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const magnitude = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  const minor = negative ? -magnitude : magnitude;
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > maxMinor ||
      (!allowZero && minor <= 0) || (!allowNegative && minor < 0)) return null;
  return minor;
}

module.exports = { parseMinorUnits };
