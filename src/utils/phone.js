'use strict';

/**
 * Pakistani phone-number normalisation and variant utilities.
 */

// ---------------------------------------------------------------------------
// normalizePKPhone
// ---------------------------------------------------------------------------

/**
 * Normalise a Pakistani phone number to the international +92 format.
 *
 * Rules applied (after stripping whitespace / dashes / parens):
 *  - 03XX… (11 digits)  → +923XX…
 *  - 92XX… (12 digits, no leading +) → +92XX…
 *  - Already +92…       → returned as-is (after cleaning)
 *  - Anything else       → returned cleaned but otherwise unchanged
 *
 * @param {string} phone - raw phone input
 * @returns {string} normalised phone string
 */
function normalizePKPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';

  // Strip whitespace, dashes, parentheses, dots
  const cleaned = phone.replace(/[\s\-().]/g, '');

  // 03XX… local mobile format (11 digits)
  if (/^0[3-9]\d{9}$/.test(cleaned)) {
    return '+92' + cleaned.slice(1);
  }

  // 92XX… without leading + (12 digits)
  if (/^92\d{10}$/.test(cleaned)) {
    return '+' + cleaned;
  }

  // Already has +92
  if (/^\+92\d{10}$/.test(cleaned)) {
    return cleaned;
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// extractLocalNumber
// ---------------------------------------------------------------------------

/**
 * Strip country code / leading zero so the number can be used for a Clinicea
 * search that expects the local portion only.
 *
 * @param {string} phone
 * @returns {string} local number (e.g. "3001234567")
 */
function extractLocalNumber(phone) {
  if (!phone || typeof phone !== 'string') return '';

  let num = phone.replace(/[\s\-().]/g, '');

  // Remove leading +
  if (num.startsWith('+')) {
    num = num.slice(1);
  }

  // Remove country code 92
  if (num.startsWith('92') && num.length > 10) {
    num = num.slice(2);
  }

  // Remove leading 0
  if (num.startsWith('0') && num.length > 1) {
    num = num.slice(1);
  }

  return num;
}

// ---------------------------------------------------------------------------
// getPhoneVariants
// ---------------------------------------------------------------------------

/**
 * Return a Set of all common format variants so that an incoming number can be
 * matched against stored numbers regardless of how either side was formatted.
 *
 * @param {string} phone
 * @returns {Set<string>}
 */
function getPhoneVariants(phone) {
  const variants = new Set();
  if (!phone || typeof phone !== 'string') return variants;

  const cleaned = phone.replace(/[\s\-().]/g, '');
  if (!cleaned) return variants;

  variants.add(cleaned);

  // Without leading +
  if (cleaned.startsWith('+')) {
    variants.add(cleaned.slice(1));
  }

  const local = extractLocalNumber(phone);
  if (local) {
    variants.add(local);          // e.g. "3001234567"
    variants.add('0' + local);    // e.g. "03001234567"
    variants.add('+92' + local);  // e.g. "+923001234567"
    variants.add('92' + local);   // e.g. "923001234567"
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalizePKPhone,
  extractLocalNumber,
  getPhoneVariants,
};
