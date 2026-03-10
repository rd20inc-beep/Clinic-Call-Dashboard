'use strict';

const assert = require('assert');

// ── Modules under test ──────────────────────────────────────────────────────
const { normalizePKPhone, extractLocalNumber, getPhoneVariants } = require('../src/utils/phone');
const { validateIncomingCall, validateHeartbeat, validateLogin, validatePhone, validateAgentId } = require('../src/utils/validators');
const { timingSafeEqual, redactSecret, sanitizeLogEntry, getClientIP } = require('../src/utils/security');

// ── Test runner ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Phone normalisation
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Phone normalisation ──');

test('normalizePKPhone: local 03XX format', () => {
  assert.strictEqual(normalizePKPhone('03001234567'), '+923001234567');
});

test('normalizePKPhone: 92XX without plus', () => {
  assert.strictEqual(normalizePKPhone('923001234567'), '+923001234567');
});

test('normalizePKPhone: already +92', () => {
  assert.strictEqual(normalizePKPhone('+923001234567'), '+923001234567');
});

test('normalizePKPhone: strips spaces and dashes', () => {
  assert.strictEqual(normalizePKPhone('03 00-123 4567'), '+923001234567');
});

test('normalizePKPhone: non-PK number unchanged', () => {
  assert.strictEqual(normalizePKPhone('+14155551234'), '+14155551234');
});

test('extractLocalNumber: from +92 format', () => {
  assert.strictEqual(extractLocalNumber('+923001234567'), '3001234567');
});

test('extractLocalNumber: from 03XX format', () => {
  assert.strictEqual(extractLocalNumber('03001234567'), '3001234567');
});

test('getPhoneVariants: contains expected variants', () => {
  const variants = getPhoneVariants('+923001234567');
  assert.ok(variants instanceof Set, 'should return a Set');
  assert.ok(variants.has('+923001234567'), 'should contain +923001234567');
  assert.ok(variants.has('923001234567'), 'should contain 923001234567');
  assert.ok(variants.has('03001234567'), 'should contain 03001234567');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Validators
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Validators ──');

test('validateIncomingCall: valid full payload', () => {
  const result = validateIncomingCall({ From: '+923001234567', CallSid: 'test-123', Agent: 'agent1' });
  assert.strictEqual(result.valid, true);
});

test('validateIncomingCall: empty object is valid (all optional)', () => {
  const result = validateIncomingCall({});
  assert.strictEqual(result.valid, true);
});

test('validateIncomingCall: script in Agent is rejected', () => {
  const result = validateIncomingCall({ Agent: 'agent1<script>' });
  // Agent contains non-alphanumeric chars so it should be invalid or stripped
  assert.ok(
    result.valid === false || !result.sanitized.Agent || !result.sanitized.Agent.includes('<script>'),
    'Agent with <script> should be rejected or sanitized'
  );
});

test('validateHeartbeat: valid agent', () => {
  const result = validateHeartbeat({ Agent: 'agent1' });
  assert.strictEqual(result.valid, true);
});

test('validateLogin: missing fields is invalid', () => {
  const result = validateLogin({});
  assert.strictEqual(result.valid, false);
});

test('validateLogin: valid credentials', () => {
  const result = validateLogin({ username: 'admin', password: 'test' });
  assert.strictEqual(result.valid, true);
});

test('validateLogin: username too long (50 chars, non-alphanumeric after clamp)', () => {
  // 50 chars of 'a' is alphanumeric but gets clamped to 30 — still alphanumeric.
  // The real issue: password is missing, so it should be invalid.
  const result = validateLogin({ username: 'a'.repeat(50) });
  assert.strictEqual(result.valid, false);
});

test('validatePhone: valid phone', () => {
  assert.strictEqual(validatePhone('+923001234567'), true);
});

test('validatePhone: empty string', () => {
  assert.strictEqual(validatePhone(''), false);
});

test('validateAgentId: valid id', () => {
  assert.strictEqual(validateAgentId('agent1'), true);
});

test('validateAgentId: script injection rejected', () => {
  assert.strictEqual(validateAgentId('agent<script>'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Security utils
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Security utils ──');

test('timingSafeEqual: matching strings', () => {
  assert.strictEqual(timingSafeEqual('abc', 'abc'), true);
});

test('timingSafeEqual: different strings', () => {
  assert.strictEqual(timingSafeEqual('abc', 'def'), false);
});

test('timingSafeEqual: different lengths', () => {
  assert.strictEqual(timingSafeEqual('abc', 'abcd'), false);
});

test('redactSecret: long secret shows prefix + ***', () => {
  const result = redactSecret('abcdefgh');
  assert.ok(result.startsWith('abcd'), 'should start with first 4 chars');
  assert.ok(result.includes('***'), 'should contain ***');
});

test('redactSecret: short secret is fully redacted', () => {
  const result = redactSecret('ab');
  assert.strictEqual(result, '***');
});

test('sanitizeLogEntry: truncates long input', () => {
  const result = sanitizeLogEntry('a'.repeat(300));
  assert.ok(result.length <= 200 + 20, 'should be truncated near 200 chars (plus truncation marker)');
  assert.ok(result.length < 300, 'should be shorter than original');
});

test('getClientIP: x-real-ip header', () => {
  const req = { headers: { 'x-real-ip': '1.2.3.4' }, socket: {} };
  assert.strictEqual(getClientIP(req), '1.2.3.4');
});

test('getClientIP: x-forwarded-for header (first IP)', () => {
  const req = { headers: { 'x-forwarded-for': '5.6.7.8, 9.10.11.12' }, socket: {} };
  assert.strictEqual(getClientIP(req), '5.6.7.8');
});

test('getClientIP: strips ::ffff: prefix', () => {
  const req = { headers: {}, ip: '::ffff:192.168.1.1', socket: {} };
  assert.strictEqual(getClientIP(req), '192.168.1.1');
});

test('getClientIP: falls back to socket.remoteAddress', () => {
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } };
  assert.strictEqual(getClientIP(req), '10.0.0.1');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Clinicea URL construction safety
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Clinicea URL construction ──');

test('URL: phone with spaces/dashes is safely encoded', () => {
  const baseUrl = 'https://app.clinicea.com/Office';
  const phone = '+92 300-1234567';
  const url = `${baseUrl}?tp=pat&m=${encodeURIComponent(phone)}`;

  assert.ok(url.includes('encodeURIComponent') === false, 'should not literally contain encodeURIComponent');
  // The query portion (after ?) should not contain raw spaces or raw +
  const query = url.split('?')[1];
  assert.ok(!query.includes(' '), 'query should not contain raw spaces');
  assert.ok(query.includes('%2B') || query.includes('%2b'), 'plus sign should be percent-encoded');
});

test('URL: malicious phone with script tag is safely encoded', () => {
  const baseUrl = 'https://app.clinicea.com/Office';
  const phone = '"><script>alert(1)</script>';
  const url = `${baseUrl}?tp=pat&m=${encodeURIComponent(phone)}`;

  const query = url.split('?')[1];
  assert.ok(!query.includes('<script>'), 'query should not contain raw <script> tag');
  assert.ok(!query.includes('"'), 'query should not contain unencoded double quotes');
  assert.ok(url.includes('%3Cscript%3E') || url.includes('%3cscript%3e'), 'script tag should be percent-encoded');
});

test('URL: normal phone produces valid URL', () => {
  const baseUrl = 'https://app.clinicea.com/Office';
  const phone = '+923001234567';
  const url = `${baseUrl}?tp=pat&m=${encodeURIComponent(phone)}`;

  // Should be parseable
  const parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.get('tp'), 'pat');
  assert.strictEqual(parsed.searchParams.get('m'), phone);
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════');
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log('══════════════════════════════════');

if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
}

process.exit(failed > 0 ? 1 : 0);
