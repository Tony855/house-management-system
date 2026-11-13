'use strict';

// Parse decimal currency input without binary floating-point multiplication.
// Returns integer minor units or null when the value is not a plain 2dp amount.
function parseMinorUnits(value, { allowZero = false, allowNegative = false, maxMinor = 1000000000 } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor > maxMinor || (!allowZero && minor <= 0)) return null;
  return minor;
}

module.exports = { parseMinorUnits };
