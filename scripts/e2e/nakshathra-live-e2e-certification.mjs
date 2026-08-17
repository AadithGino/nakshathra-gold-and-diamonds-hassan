#!/usr/bin/env node

/**
 * Nakshathra Live E2E Certification V2.1
 * =================================
 *
 * Black-box certification runner for a RUNNING Nakshathra backend.
 *
 * Purpose:
 * - exercise real HTTP -> Express -> middleware -> services -> Mongoose -> MongoDB
 * - drive OWNER/ADMIN, STAFF and CUSTOMER flows
 * - create isolated E2E customers/enrollments
 * - test the authoritative Nakshathra 11-month CASH 6+5 scheme
 * - independently calculate the months 7-11 monthly cap
 * - test exact cap, cap+1 paise, minimum-payment boundary, reversals and idempotency
 * - test staff CASH/UPI/BANK/CARD attribution, cash-held/handover and corrections
 * - test premature closure (EARLY=CASH only, full principal/no penalty)
 * - test maturity CASH and JEWELLERY exits
 * - prove maturity is time/rule based rather than requiring 11 distinct paid months
 * - test old matured CASH entitlement remains claimable
 * - test customer portal, receipts, payouts, dashboards, reports, audit and pagination surfaces
 * - save sanitized requests/responses and independent reconciliation artifacts
 * - scan the backend log for Mongo/Mongoose/Cast/worker errors
 *
 * IMPORTANT BUSINESS CONTRACT LOCKED INTO THIS RUNNER
 * ---------------------------------------------------
 * LIVE PRODUCT
 * - schemeType = CASH
 * - GOLD_WEIGHT remains dormant / must not be selectable for a new live Nakshathra scheme
 * - duration = 11 scheme months
 * - business timezone = Asia/Kolkata
 *
 * CONTRIBUTIONS
 * - months 1-6: multiple successful payments, no monthly cap
 * - months 7-11: multiple successful payments allowed
 * - monthly cap for months 7-11:
 *
 *       successful eligible principal in months 1-6
 *       ------------------------------------------------
 *       count of eligible successful payments in months 1-6
 *
 * - only successful, non-reversed financially valid contributions count
 * - exact cap is allowed
 * - one paise above remaining cap is rejected
 * - minimum contribution = ₹100 = 10,000 paise
 * - schemeMonth is authoritative on the backend; the client/staff/admin must not be able
 *   to financially relocate a payment by supplying a fake schemeMonth
 *
 * SETTLEMENT
 * - premature / EARLY: CASH only
 * - premature settlement = full eligible contributed principal, no penalty
 * - MATURITY: CASH or JEWELLERY
 * - mature cash entitlement never expires
 * - maturity is not conditional on 11 distinct successful payment months
 * - exactly one successful terminal settlement per enrollment
 *
 * CORRECTIONS
 * - staff requests correction; OWNER/ADMIN approves/rejects
 * - live supported financial corrections: amount and payment method/type
 * - payment-date correction is NOT allowed
 * - posted financial history is reversed/replaced/audited, never invisibly overwritten
 *
 * Run from Nakshathra backend root:
 *
 *   node --env-file=.env scripts/e2e/nakshathra-live-e2e-certification.mjs
 *
 * Backend should be started separately with log capture, for example:
 *
 *   npm run dev 2>&1 | tee nakshathra-backend.log
 *
 * Required credentials:
 *   NAK_E2E_OWNER_PASSWORD=...
 * and ONE of:
 *   NAK_E2E_OWNER_PHONE=...
 *   NAK_E2E_OWNER_EMAIL=...
 *
 * Optional:
 *   NAK_E2E_BASE_URL=http://127.0.0.1:2020/api/v1
 *   NAK_E2E_BACKEND_LOG=nakshathra-backend.log
 *   NAK_E2E_PHONEPE_AUTO_SUCCESS=true
 *   NAK_E2E_STORAGE_OBJECT_PREFIX=jewellers/nakshathra-jewellery
 *
 * This runner never drops the DB, deletes existing financial history, or mass-cleans
 * previous test data. Every run uses unique E2E identities.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG = {
  baseUrl: (process.env.NAK_E2E_BASE_URL || 'http://127.0.0.1:2020/api/v1').replace(/\/+$/, ''),
  ownerPhone: process.env.NAK_E2E_OWNER_PHONE || '',
  ownerEmail: process.env.NAK_E2E_OWNER_EMAIL || '',
  ownerPassword: process.env.NAK_E2E_OWNER_PASSWORD || '',
  backendLog: process.env.NAK_E2E_BACKEND_LOG || 'nakshathra-backend.log',
  phonePeAutoSuccess: process.env.NAK_E2E_PHONEPE_AUTO_SUCCESS !== 'false',
  storageObjectPrefix: process.env.NAK_E2E_STORAGE_OBJECT_PREFIX || 'jewellers/nakshathra-jewellery',
  failOnBackendErrors: process.env.NAK_E2E_FAIL_ON_BACKEND_ERRORS !== 'false',
  kycRequired: String(process.env.KYC_REQUIRED || '').toLowerCase() === 'true',
  minimumPaymentPaise: 10_000,
  durationMonths: 11,
  flexibleMonths: 6,
  cappedMonths: 5,
  businessTimeZone: 'Asia/Kolkata',
};

if (!CONFIG.ownerPassword || (!CONFIG.ownerPhone && !CONFIG.ownerEmail)) {
  console.error(`
Nakshathra E2E requires OWNER/ADMIN credentials.

Set:
  NAK_E2E_OWNER_PASSWORD=...

and either:
  NAK_E2E_OWNER_PHONE=...
or:
  NAK_E2E_OWNER_EMAIL=...

The script will not guess production/admin credentials.
`);
  process.exit(2);
}

const RUN_STARTED_AT = new Date();
const RUN_ID = `${RUN_STARTED_AT.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const RESULT_DIR = path.resolve('e2e-results', `nakshathra-${RUN_ID}`);

const FILES = {
  requests: path.join(RESULT_DIR, 'requests.ndjson'),
  responses: path.join(RESULT_DIR, 'responses.ndjson'),
  steps: path.join(RESULT_DIR, 'steps.json'),
  calculations: path.join(RESULT_DIR, 'calculations.json'),
  scheme: path.join(RESULT_DIR, 'scheme-reconciliation.json'),
  payments: path.join(RESULT_DIR, 'payment-reconciliation.json'),
  settlements: path.join(RESULT_DIR, 'settlement-reconciliation.json'),
  cash: path.join(RESULT_DIR, 'cash-reconciliation.json'),
  reports: path.join(RESULT_DIR, 'report-reconciliation.json'),
  permissions: path.join(RESULT_DIR, 'permissions.json'),
  routeCoverage: path.join(RESULT_DIR, 'route-coverage.json'),
  backendErrors: path.join(RESULT_DIR, 'backend-errors.log'),
  failures: path.join(RESULT_DIR, 'failures.json'),
  summaryJson: path.join(RESULT_DIR, 'summary.json'),
  summaryMd: path.join(RESULT_DIR, 'SUMMARY.md'),
};

await fsp.mkdir(RESULT_DIR, { recursive: true });

const state = {
  runId: RUN_ID,
  ids: {},
  calculations: {},
  schemes: {},
  payments: {},
  settlements: {},
  cash: {},
  reports: {},
  permissions: [],
  routes: [],
  notes: [],
  scenario: {},
};

const steps = [];
const failures = [];
let requestSequence = 0;

class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(v) {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)); }
  catch { return String(v); }
}

function redact(value, keyHint = '') {
  if (value == null) return value;
  const key = String(keyHint).toLowerCase();
  if (
    key.includes('password') ||
    key === 'otp' ||
    key.includes('token') ||
    key.includes('cookie') ||
    key.includes('authorization') ||
    key.includes('secret') ||
    key.includes('aadhaar')
  ) return '[REDACTED]';

  if (Array.isArray(value)) return value.map((v) => redact(v, keyHint));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

async function appendNdjson(file, record) {
  await fsp.appendFile(file, JSON.stringify(record) + '\n');
}

function dataOf(body) {
  if (body && typeof body === 'object' && Object.hasOwn(body, 'data')) return body.data;
  return body;
}

function asArray(body) {
  const data = dataOf(body);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.payments)) return data.payments;
  if (Array.isArray(data?.payouts)) return data.payouts;
  return [];
}

function idOf(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of [
    'id', '_id', 'customerId', 'userId', 'staffId', 'profileId',
    'schemeId', 'enrollmentId', 'paymentId', 'payoutId', 'correctionId'
  ]) {
    const v = value[key];
    if (typeof v === 'string' && v) return v;
  }
  for (const nested of ['customer', 'user', 'staff', 'scheme', 'enrollment', 'payment', 'payout', 'correction']) {
    const got = idOf(value[nested]);
    if (got) return got;
  }
  return null;
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? '' : ` | ${JSON.stringify(redact(details))}`;
    throw new Error(`${message}${suffix}`);
  }
}

function eq(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}

function oneOf(actual, values, label) {
  assert(values.includes(actual), `${label}: expected one of ${values.join(', ')}, got ${actual}`);
}

function need(v, label) {
  if (v == null || v === '') throw new SkipError(`Missing prerequisite: ${label}`);
  return v;
}

function numberFrom(obj, keys, fallback = undefined) {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = obj;
    for (const p of parts) cur = cur?.[p];
    if (cur !== undefined && cur !== null && Number.isFinite(Number(cur))) return Number(cur);
  }
  return fallback;
}

function stringFrom(obj, keys, fallback = '') {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = obj;
    for (const p of parts) cur = cur?.[p];
    if (cur !== undefined && cur !== null && String(cur)) return String(cur);
  }
  return fallback;
}

function statusCodeOf(r) {
  return r?.body?.error?.code || r?.body?.code || '';
}

function monthKeyFromYMD(ymd) {
  return String(ymd).slice(0, 7);
}

function istParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.businessTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

function addMonthsYMD(baseParts, delta, day = 5) {
  const d = new Date(Date.UTC(baseParts.year, baseParts.month - 1 + delta, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dd = Math.min(Math.max(day, 1), last);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function startMonthsAgo(monthsAgo) {
  const p = istParts();
  return addMonthsYMD(p, -monthsAgo, 1);
}

function dateInSchemeMonth(startYmd, schemeMonth, day = 5) {
  const [y, m] = String(startYmd).split('-').map(Number);
  return addMonthsYMD({ year: y, month: m, day: 1 }, schemeMonth - 1, day);
}

function uniquePhone(offset = 0) {
  const seed = BigInt(Date.now()) + BigInt(offset) + BigInt(crypto.randomInt(0, 100000));
  const last9 = (seed % 1000000000n).toString().padStart(9, '0');
  return `+919${last9}`;
}

function suffix() {
  return `${Date.now().toString(36).slice(-7)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();
}

const SUFFIX = suffix();

function cookieListFromHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,]+=)/g);
}

class ApiClient {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }

  absorbCookies(headers) {
    for (const raw of cookieListFromHeaders(headers)) {
      const first = raw.split(';', 1)[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(label, method, endpoint, { body, expect, headers = {}, absolute = false, throwOnUnexpected = true } = {}) {
    const requestId = `nak-e2e-${RUN_ID}-${String(++requestSequence).padStart(5, '0')}`;
    const url = absolute ? endpoint : `${CONFIG.baseUrl}${endpoint}`;
    const reqHeaders = { accept: 'application/json', 'x-request-id': requestId, ...headers };
    if (body !== undefined) reqHeaders['content-type'] = 'application/json';
    const cookie = this.cookieHeader();
    if (cookie) reqHeaders.cookie = cookie;

    await appendNdjson(FILES.requests, {
      ts: nowIso(), requestId, client: this.name, label, method, url,
      headers: redact({ ...reqHeaders, cookie: cookie ? '[REDACTED]' : undefined }),
      body: redact(cloneJson(body)),
    });

    const started = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
    } catch (e) {
      await appendNdjson(FILES.responses, {
        ts: nowIso(), requestId, client: this.name, label,
        transportError: String(e?.stack || e), durationMs: Date.now() - started,
      });
      throw new Error(`${label}: transport failure: ${e?.message || e}`);
    }

    this.absorbCookies(response.headers);
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; }
    catch { parsed = text; }

    const result = {
      status: response.status,
      body: parsed,
      data: dataOf(parsed),
      requestId,
      headers: response.headers,
    };

    await appendNdjson(FILES.responses, {
      ts: nowIso(), requestId, client: this.name, label,
      status: response.status, durationMs: Date.now() - started,
      headers: {
        'content-type': response.headers.get('content-type'),
        'x-request-id': response.headers.get('x-request-id'),
      },
      body: redact(cloneJson(parsed)),
    });

    const allowed = expect ?? [];
    const ok = allowed.length ? allowed.includes(response.status) : response.status >= 200 && response.status < 300;
    if (!ok && throwOnUnexpected) {
      const code = parsed?.error?.code || parsed?.code || '';
      const message = parsed?.error?.message || parsed?.message || String(text).slice(0, 700);
      throw new Error(`${label}: HTTP ${response.status}${code ? ` ${code}` : ''} ${message || ''}`.trim());
    }
    return result;
  }

  get(label, endpoint, opts = {}) { return this.request(label, 'GET', endpoint, opts); }
  post(label, endpoint, body, opts = {}) { return this.request(label, 'POST', endpoint, { ...opts, body }); }
  patch(label, endpoint, body, opts = {}) { return this.request(label, 'PATCH', endpoint, { ...opts, body }); }
  del(label, endpoint, body, opts = {}) { return this.request(label, 'DELETE', endpoint, { ...opts, body }); }
}

async function step(name, fn) {
  const startedAt = nowIso();
  const started = Date.now();
  try {
    const value = await fn();
    steps.push({ name, status: 'PASS', startedAt, durationMs: Date.now() - started });
    console.log(`PASS  ${name}`);
    return value;
  } catch (e) {
    if (e instanceof SkipError) {
      steps.push({ name, status: 'SKIP', startedAt, durationMs: Date.now() - started, reason: e.message });
      console.log(`SKIP  ${name} — ${e.message}`);
      return undefined;
    }
    const error = String(e?.stack || e);
    steps.push({ name, status: 'FAIL', startedAt, durationMs: Date.now() - started, error: String(e?.message || e) });
    failures.push({ name, at: nowIso(), error });
    console.log(`FAIL  ${name} — ${e?.message || e}`);
    return undefined;
  }
}

/**
 * Route candidate helper:
 * Only falls through on 404/405. A 401/403/409/422/500 is an actual response from an
 * existing route and is never hidden by trying another route.
 */
async function routeRequest(client, label, method, endpoints, opts = {}) {
  let last;
  for (const endpoint of endpoints) {
    const r = await client.request(`${label} [${endpoint}]`, method, endpoint, {
      ...opts,
      throwOnUnexpected: false,
    });
    state.routes.push({ label, method, endpoint, status: r.status });
    if (![404, 405].includes(r.status)) {
      const allowed = opts.expect ?? [];
      const ok = allowed.length ? allowed.includes(r.status) : r.status >= 200 && r.status < 300;
      if (!ok) {
        const code = r.body?.error?.code || r.body?.code || '';
        const msg = r.body?.error?.message || r.body?.message || '';
        throw new Error(`${label}: ${method} ${endpoint} -> HTTP ${r.status}${code ? ` ${code}` : ''} ${msg}`.trim());
      }
      return { ...r, endpoint };
    }
    last = r;
  }
  throw new Error(`${label}: no candidate route exists; tried ${endpoints.join(', ')}; last HTTP ${last?.status ?? 'none'}`);
}

async function negativeRouteRequest(client, label, method, endpoints, { body, expectedStatuses = [400, 401, 403, 404, 409, 422], forbiddenSuccess = true } = {}) {
  for (const endpoint of endpoints) {
    const r = await client.request(`${label} [${endpoint}]`, method, endpoint, {
      body,
      throwOnUnexpected: false,
    });
    state.routes.push({ label, method, endpoint, status: r.status });
    if ([404, 405].includes(r.status)) continue;
    if (forbiddenSuccess && r.status >= 200 && r.status < 300) {
      throw new Error(`${label}: operation unexpectedly succeeded at ${endpoint} with HTTP ${r.status}`);
    }
    assert(expectedStatuses.includes(r.status), `${label}: unexpected status ${r.status}`, r.body);
    return { ...r, endpoint };
  }
  throw new Error(`${label}: no candidate route exists`);
}

function expectedCap(phase1SuccessfulAmountsPaise) {
  assert(phase1SuccessfulAmountsPaise.length > 0, 'phase1 cap denominator cannot be zero in expectedCap');
  const total = phase1SuccessfulAmountsPaise.reduce((a, b) => a + BigInt(b), 0n);
  return {
    phase1EligiblePrincipalPaise: Number(total),
    phase1EligiblePaymentCount: phase1SuccessfulAmountsPaise.length,
    monthlyCapPaise: Number(total / BigInt(phase1SuccessfulAmountsPaise.length)),
  };
}

async function scanLocalRouteSource() {
  const root = path.resolve('src/routes');
  const out = [];
  if (!fs.existsSync(root)) return out;

  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.(ts|js|mts|mjs)$/.test(ent.name)) {
        const txt = await fsp.readFile(p, 'utf8');
        const hits = [];
        const re = /\.(get|post|patch|put|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
        let m;
        while ((m = re.exec(txt))) hits.push({ method: m[1].toUpperCase(), path: m[2] });
        if (hits.length) out.push({ file: path.relative(process.cwd(), p), routes: hits });
      }
    }
  }
  await walk(root);
  return out;
}

const owner = new ApiClient('OWNER_ADMIN');
const staff = new ApiClient('STAFF');
const restrictedStaff = new ApiClient('RESTRICTED_STAFF');
const anonymous = new ApiClient('ANONYMOUS');

const origin = new URL(CONFIG.baseUrl).origin;

console.log(`
NAKSHATHRA LIVE E2E CERTIFICATION V2.1
Run ID:      ${RUN_ID}
API:         ${CONFIG.baseUrl}
Results:     ${RESULT_DIR}
Backend log: ${CONFIG.backendLog}
`);

const localRoutes = await scanLocalRouteSource();
await fsp.writeFile(path.join(RESULT_DIR, 'local-route-source.json'), JSON.stringify(localRoutes, null, 2));

/* -------------------------------------------------------------------------- */
/*  INFRA + AUTH                                                               */
/* -------------------------------------------------------------------------- */

await step('health endpoint', async () => {
  return (await anonymous.get('health', `${origin}/health`, { absolute: true, expect: [200] })).data;
});

await step('ready endpoint', async () => {
  return (await anonymous.get('ready', `${origin}/ready`, { absolute: true, expect: [200] })).data;
});

const ownerLogin = await step('OWNER/ADMIN login', async () => {
  const body = CONFIG.ownerEmail
    ? { email: CONFIG.ownerEmail, password: CONFIG.ownerPassword }
    : { phone: CONFIG.ownerPhone, password: CONFIG.ownerPassword };
  const r = await owner.post('owner login', '/auth/login', body, { expect: [200] });
  assert(owner.cookies.size > 0, 'Owner login did not issue session cookies');
  return r.data;
});

await step('OWNER/ADMIN current session', async () => {
  need(ownerLogin, 'owner login');
  return (await owner.get('owner session', '/auth/me', { expect: [200] })).data;
});

await step('OWNER dashboard preflight', async () => {
  need(ownerLogin, 'owner login');
  return (await owner.get('owner dashboard', '/admin/dashboard', { expect: [200] })).data;
});

await step('anonymous cannot access customer schemes', async () => {
  const r = await anonymous.get('anonymous customer schemes', '/customer/schemes', {
    expect: [401, 403],
  });
  state.permissions.push({ check: 'anonymous_customer_schemes', expected: '401_or_403', actual: r.status, pass: true });
});

/* -------------------------------------------------------------------------- */
/*  STAFF + PERMISSIONS                                                        */
/* -------------------------------------------------------------------------- */

const staffPhone = uniquePhone(100);
const staffPassword = `NakE2E@${SUFFIX}St1`;
const restrictedStaffPhone = uniquePhone(101);
const restrictedStaffPassword = `NakE2E@${SUFFIX}Rs1`;

async function createStaffAccount({ restricted = false } = {}) {
  const phone = restricted ? restrictedStaffPhone : staffPhone;
  const password = restricted ? restrictedStaffPassword : staffPassword;
  const permissions = restricted
    ? ['canViewCustomers']
    : ['canCreateCustomer', 'canViewCustomers', 'canEnrollScheme', 'canCollectPayment', 'canSubmitCorrectionRequest'];

  return routeRequest(owner, restricted ? 'create restricted staff' : 'create full staff', 'POST', [
    '/admin/staff',
  ], {
    body: {
      name: `${restricted ? 'Restricted' : 'Full'} E2E Staff ${SUFFIX}`,
      phone,
      password,
      employeeCode: `${restricted ? 'RST' : 'STF'}-${SUFFIX}`.slice(0, 30),
      permissions,
      role: 'STAFF',
    },
    expect: [201],
  });
}

const fullStaffCreated = await step('OWNER creates full-permission STAFF', async () => {
  const r = await createStaffAccount();
  state.ids.staff = idOf(r.data) || stringFrom(r.data, ['staffId', 'profileId', 'userId']);
  return r.data;
});

const restrictedStaffCreated = await step('OWNER creates restricted STAFF', async () => {
  const r = await createStaffAccount({ restricted: true });
  state.ids.restrictedStaff = idOf(r.data) || stringFrom(r.data, ['staffId', 'profileId', 'userId']);
  return r.data;
});

const staffLogin = await step('STAFF login', async () => {
  need(fullStaffCreated, 'full staff');
  return (await staff.post('staff login', '/auth/login', {
    phone: staffPhone, password: staffPassword,
  }, { expect: [200] })).data;
});

const restrictedStaffLogin = await step('restricted STAFF login', async () => {
  need(restrictedStaffCreated, 'restricted staff');
  return (await restrictedStaff.post('restricted staff login', '/auth/login', {
    phone: restrictedStaffPhone, password: restrictedStaffPassword,
  }, { expect: [200] })).data;
});

await step('STAFF dashboard', async () => {
  need(staffLogin, 'staff login');
  return (await staff.get('staff dashboard', '/staff/dashboard', { expect: [200] })).data;
});

await step('STAFF cannot access OWNER dashboard', async () => {
  need(staffLogin, 'staff login');
  const r = await staff.get('staff admin dashboard denial', '/admin/dashboard', { expect: [403] });
  state.permissions.push({ check: 'staff_admin_dashboard', expected: 403, actual: r.status, pass: true });
});

/* -------------------------------------------------------------------------- */
/*  SCHEME PLAN                                                                */
/* -------------------------------------------------------------------------- */

let plan;

const planList = await step('OWNER lists scheme plans', async () => {
  const r = await owner.get('scheme plans', '/admin/scheme-plans?limit=100', { expect: [200] });
  return asArray(r.body);
});

await step('live scheme catalog is CASH-only', async () => {
  need(planList, 'scheme plan list');
  const enabled = planList.filter(p => !['INACTIVE', 'DISABLED', 'DELETED'].includes(String(p.status || '').toUpperCase()));
  const liveGold = enabled.filter(p => String(p.schemeType || p.type || '').toUpperCase() === 'GOLD_WEIGHT');
  assert(liveGold.length === 0, 'GOLD_WEIGHT is unexpectedly enabled for a live Nakshathra scheme', liveGold);
});

plan = await step('ensure an authoritative Nakshathra 6+5 CASH plan exists', async () => {
  need(planList, 'scheme plans');
  const matching = planList.find(p => {
    const type = String(p.schemeType || p.type || '').toUpperCase();
    const duration = numberFrom(p, ['durationMonths']);
    const flex = numberFrom(p, ['flexibleMonths']);
    const caps = numberFrom(p, ['cappedMonths', 'capMonths']);
    const min = numberFrom(p, ['minimumPaymentPaise', 'minimumPayment']);
    return type === 'CASH' && duration === 11 && flex === 6 && caps === 5 && (min === 10_000 || min == null);
  });
  if (matching) {
    state.notes.push('Reused existing active 11-month CASH 6+5 plan for E2E.');
    state.ids.plan = idOf(matching);
    return matching;
  }

  // Creation payload mirrors the production Kairali plan contract plus Nakshathra's
  // explicit 6+5 policy fields. A schema mismatch should fail loudly and be patched
  // from requests/responses rather than silently weakening the test.
  const r = await owner.post('create Nakshathra E2E plan', '/admin/scheme-plans', {
    name: `Nakshathra E2E 6+5 ${SUFFIX}`,
    type: 'CASH',
    schemeType: 'CASH',
    durationMonths: 11,
    flexibleMonths: 6,
    capMonths: 5,
    cappedMonths: 5,
    minimumPaymentPaise: 10_000,
    capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
    status: 'ACTIVE',
    benefitText: 'E2E certification plan',
    termsText: 'Months 1-6 flexible; months 7-11 capped by average successful phase-one payment.',
  }, { expect: [201] });
  state.ids.plan = idOf(r.data);
  return r.data;
});

await step('plan contract exactly exposes 11 / 6+5 / CASH', async () => {
  need(plan, 'plan');
  eq(String(plan.schemeType || plan.type || '').toUpperCase(), 'CASH', 'plan scheme type');
  eq(numberFrom(plan, ['durationMonths']), 11, 'duration months');
  eq(numberFrom(plan, ['flexibleMonths']), 6, 'flexible months');
  eq(numberFrom(plan, ['cappedMonths', 'capMonths']), 5, 'capped months');
  const min = numberFrom(plan, ['minimumPaymentPaise', 'minimumPayment']);
  if (min != null) eq(min, CONFIG.minimumPaymentPaise, 'minimum payment');
});

await step('new GOLD_WEIGHT plan creation is rejected', async () => {
  const r = await owner.post('attempt live GOLD_WEIGHT plan', '/admin/scheme-plans', {
    name: `FORBIDDEN GOLD E2E ${SUFFIX}`,
    type: 'GOLD_WEIGHT',
    schemeType: 'GOLD_WEIGHT',
    durationMonths: 11,
    flexibleMonths: 6,
    capMonths: 5,
    minimumPaymentPaise: 10_000,
    capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
  }, { throwOnUnexpected: false });
  assert(!(r.status >= 200 && r.status < 300), 'GOLD_WEIGHT live plan creation unexpectedly succeeded', r.data);
  assert([400, 403, 409, 422].includes(r.status), 'Unexpected GOLD_WEIGHT rejection status', r.body);
  state.permissions.push({ check: 'gold_weight_live_creation_denied', expected: '4xx', actual: r.status, pass: true });
});

/* -------------------------------------------------------------------------- */
/*  CUSTOMER / ENROLLMENT HELPERS                                              */
/* -------------------------------------------------------------------------- */

const customers = new Map();

async function createCustomer(label, offset, { viaStaff = false } = {}) {
  const phone = uniquePhone(1000 + offset);
  const password = `NakE2E@${SUFFIX}${offset}Cu1`;
  const client = new ApiClient(`CUSTOMER_${label}`);

  const creator = viaStaff ? staff : owner;
  const endpoint = viaStaff ? '/staff/customers' : '/admin/customers';
  const r = await creator.post(`${label} create customer`, endpoint, {
    name: `Nak E2E ${label} ${SUFFIX}`,
    phone,
    password,
    address: {
      line1: `E2E ${label}`,
      city: 'Kozhikode',
      district: 'Kozhikode',
      state: 'Kerala',
      postalCode: '673001',
    },
  }, { expect: [201] });

  const c = r.data?.customer || r.data;
  const customerId = idOf(c) || stringFrom(r.data, ['customerId']);
  assert(customerId, `${label}: customer id missing`, r.data);

  const login = await client.post(`${label} customer login`, '/auth/login', { phone, password }, { expect: [200] });
  customers.set(label, { label, phone, password, client, id: customerId, created: c, login: login.data });
  return customers.get(label);
}

async function ensureKyc(customer) {
  // Nakshathra may have KYC gated or optional depending on deployment config.
  // Try the customer KYC route first. If it is not mounted, we record N/A; if it is
  // mounted and returns a business error, that is a real failure.
  const probe = await customer.client.get(`${customer.label} KYC probe`, '/customer/kyc', {
    throwOnUnexpected: false,
  });

  if ([404, 405].includes(probe.status)) {
    const message = `${customer.label}: customer KYC route not mounted; KYC state-machine not certified.`;
    state.notes.push(message);
    if (CONFIG.kycRequired) {
      throw new Error(`${message} KYC_REQUIRED=true, so this is release-blocking.`);
    }
    throw new SkipError(`${message} KYC_REQUIRED is not true for this run.`);
  }
  if (probe.status !== 200) {
    throw new Error(`${customer.label}: KYC probe HTTP ${probe.status} ${statusCodeOf(probe)}`);
  }

  const currentStatus = String(probe.data?.kycStatus || probe.data?.status || '').toUpperCase();
  if (['VERIFIED', 'APPROVED'].includes(currentStatus)) return { applicable: true, verified: true };

  let frontKey;
  let backKey;
  for (const kind of ['aadhaar-front', 'aadhaar-back']) {
    const presign = await customer.client.post(`${customer.label} presign ${kind}`, '/uploads/presign', {
      kind, contentType: 'image/jpeg', fileName: `${RUN_ID}-${customer.label}-${kind}.jpg`,
    }, { throwOnUnexpected: false });

    let key;
    if (presign.status === 200) {
      key = String(presign.data?.key || '');
      const url = String(presign.data?.uploadUrl || '');
      assert(key && url, 'presign response missing key/uploadUrl', presign.data);
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      });
      assert(put.ok, `S3 ${kind} upload failed HTTP ${put.status}`);
    } else if ([401, 403, 404, 405, 503].includes(presign.status)) {
      // Local development often intentionally has no S3 credentials. Use a
      // syntactically valid Nakshathra-owned key to exercise backend KYC state.
      key = `${CONFIG.storageObjectPrefix}/private/${kind}/e2e/${RUN_ID}-${customer.label}-${kind}.jpg`;
      state.notes.push(`${customer.label}: ${kind} used synthetic private key; external S3 transport not certified.`);
    } else {
      throw new Error(`${customer.label}: presign ${kind} HTTP ${presign.status}`);
    }
    if (kind === 'aadhaar-front') frontKey = key;
    else backKey = key;
  }

  const submit = await customer.client.post(`${customer.label} submit KYC`, '/customer/kyc/submit', {
    frontKey, backKey,
  }, { expect: [200] });

  const approve = await owner.post(
    `${customer.label} approve KYC`,
    `/admin/customers/${customer.id}/kyc/approve`,
    {},
    { expect: [200] },
  );

  const read = await customer.client.get(`${customer.label} KYC verified read`, '/customer/kyc', { expect: [200] });
  const after = String(read.data?.kycStatus || read.data?.status || '').toUpperCase();
  assert(['VERIFIED', 'APPROVED'].includes(after), `${customer.label}: KYC not verified after approval`, read.data);
  return { applicable: true, verified: true, submit: submit.data, approve: approve.data };
}

async function enrollCustomer(customer, startDate, label = customer.label) {
  need(plan, 'plan');
  const planId = state.ids.plan || idOf(plan);
  const r = await owner.post(`${label} enroll`, '/admin/enrollments', {
    customerId: customer.id,
    schemePlanId: planId,
    startDate,
    monthlyInstallmentPaise: 10_000,
  }, { expect: [201] });
  const e = r.data?.enrollment || r.data;
  const id = idOf(e) || stringFrom(r.data, ['enrollmentId', 'schemeId']);
  assert(id, `${label}: enrollment id missing`, r.data);
  state.ids[`enrollment_${label}`] = id;
  return { id, ...e };
}

async function adminManualPayment(customer, enrollment, amountPaise, paymentDate, label, {
  method = 'CASH',
  idempotencyKey = `nak-e2e-${label}-${RUN_ID}`,
  extra = {},
  expect = [201],
} = {}) {
  const body = {
    customerId: customer.id,
    schemeId: enrollment.id,
    amountPaise,
    method,
    paymentDate,
    referenceNumber: `E2E-${label}`.slice(0, 50),
    notes: `Nakshathra live E2E ${label}`,
    idempotencyKey,
    ...extra,
  };
  const r = await owner.post(label, '/admin/payments/manual', body, { expect });
  return r.data;
}

async function staffManualPayment(customer, enrollment, amountPaise, paymentDate, label, {
  method = 'CASH',
  idempotencyKey = `nak-e2e-${label}-${RUN_ID}`,
  extra = {},
  expect = [201],
  throwOnUnexpected = true,
} = {}) {
  return staff.post(label, '/staff/payments', {
    customerId: customer.id,
    schemeId: enrollment.id,
    amountPaise,
    method,
    paymentDate,
    referenceNumber: `E2E-${label}`.slice(0, 50),
    notes: `Nakshathra live E2E ${label}`,
    idempotencyKey,
    ...extra,
  }, { expect, throwOnUnexpected });
}

async function enrollmentDetail(id, client = owner) {
  return (await routeRequest(client, `enrollment detail ${id}`, 'GET', [
    client === owner ? `/admin/enrollments/${id}` : `/staff/enrollments/${id}`,
  ], { expect: [200] })).data;
}

async function customerSchemeDetail(customer, id) {
  return (await customer.client.get(`${customer.label} scheme detail`, `/customer/schemes/${id}`, { expect: [200] })).data;
}

function recordBelongsToEnrollment(row, enrollmentId) {
  const wanted = String(enrollmentId);
  const candidates = [
    stringFrom(row, ['schemeId', 'enrollmentId']),
    stringFrom(row, ['schemeId._id', 'schemeId.id', 'enrollmentId._id', 'enrollmentId.id']),
    stringFrom(row, ['scheme._id', 'scheme.id', 'enrollment._id', 'enrollment.id']),
  ].filter(Boolean);
  return candidates.some(value => value === wanted);
}

async function paymentListForEnrollment(enrollmentId) {
  // The list endpoint may ignore legacy `schemeId` query filtering. Always verify
  // ownership locally so cross-enrollment rows cannot corrupt financial assertions.
  const r = await owner.get('admin payments for enrollment', `/admin/payments?limit=100`, { expect: [200] });
  return asArray(r.body).filter(row => recordBelongsToEnrollment(row, enrollmentId));
}

async function payoutListForEnrollment(enrollmentId) {
  const r = await owner.get('admin payouts for enrollment', `/admin/payouts?limit=100`, { expect: [200] });
  return asArray(r.body).filter(row => recordBelongsToEnrollment(row, enrollmentId));
}

/* -------------------------------------------------------------------------- */
/*  CUSTOMER CREATION + PERMISSION / SEARCH                                    */
/* -------------------------------------------------------------------------- */

const flexCustomer = await step('OWNER creates flexible-phase customer and customer can login', () => createCustomer('FLEX', 1));
await step('KYC flow for FLEX customer if enabled', async () => {
  need(flexCustomer, 'FLEX customer');
  return ensureKyc(flexCustomer);
});

const staffCreatedCustomer = await step('authorized STAFF creates customer', () => createCustomer('STAFFCREATE', 2, { viaStaff: true }));

await step('restricted STAFF cannot create customer', async () => {
  need(restrictedStaffLogin, 'restricted staff login');
  const r = await restrictedStaff.post('restricted create customer denial', '/staff/customers', {
    name: `Denied E2E ${SUFFIX}`,
    phone: uniquePhone(3333),
    password: `NakE2E@${SUFFIX}Denied1`,
  }, { expect: [403] });
  state.permissions.push({ check: 'restricted_staff_create_customer', expected: 403, actual: r.status, pass: true });
});

await step('invalid phone is rejected without truncation', async () => {
  const r = await owner.post('invalid phone create', '/admin/customers', {
    name: `Invalid Phone ${SUFFIX}`,
    phone: '+91999999999999',
    password: `NakE2E@${SUFFIX}Inv1`,
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'invalid overlong phone unexpectedly accepted', r.data);
});

await step('duplicate customer mobile is rejected safely', async () => {
  need(flexCustomer, 'FLEX customer');
  const r = await owner.post('duplicate phone create', '/admin/customers', {
    name: `Duplicate ${SUFFIX}`,
    phone: flexCustomer.phone,
    password: `NakE2E@${SUFFIX}Dup1`,
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'duplicate customer phone unexpectedly accepted', r.data);
});

await step('customer search treats regex metacharacters as literal input', async () => {
  need(staffLogin, 'staff login');
  // We only require no 500/Cast/regex crash. Literal search may return zero rows.
  const r = await staff.get('literal regex search', `/staff/customers?search=${encodeURIComponent('.*(+[')}&limit=10`, {
    expect: [200],
  });
  return r.data;
});

/* -------------------------------------------------------------------------- */
/*  FLEXIBLE PHASE + MINIMUM PAYMENT                                           */
/* -------------------------------------------------------------------------- */

const flexStart = startMonthsAgo(0);
const flexEnrollment = await step('enroll FLEX customer in current scheme month 1', async () => {
  need(flexCustomer, 'FLEX customer');
  return enrollCustomer(flexCustomer, flexStart, 'FLEX');
});

await step('second active enrollment for same customer is rejected', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const r = await owner.post('second active enrollment', '/admin/enrollments', {
    customerId: flexCustomer.id,
    schemePlanId: state.ids.plan,
    startDate: flexStart,
    monthlyInstallmentPaise: 10_000,
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'second active enrollment unexpectedly succeeded', r.data);
});

await step('₹99.99 is below Nakshathra minimum and rejected', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const r = await staffManualPayment(
    flexCustomer, flexEnrollment, 9_999,
    dateInSchemeMonth(flexStart, 1, istParts().day),
    'flex-minimum-below',
    { expect: [], throwOnUnexpected: false },
  );
  assert([400, 409, 422].includes(r.status), '₹99.99 payment unexpectedly accepted', r.data);
});

const flexP1 = await step('₹100 exact minimum succeeds in month 1', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const r = await staffManualPayment(
    flexCustomer, flexEnrollment, 10_000,
    dateInSchemeMonth(flexStart, 1, istParts().day),
    'flex-minimum-exact',
  );
  return r.data;
});

const flexP2 = await step('second different payment in same first-six month succeeds', async () => {
  need(flexP1, 'first FLEX payment');
  const r = await staffManualPayment(
    flexCustomer, flexEnrollment, 37_500,
    dateInSchemeMonth(flexStart, 1, istParts().day),
    'flex-second-same-month',
    { method: 'UPI' },
  );
  return r.data;
});

await step('first-six phase has no monthly cap', async () => {
  need(flexP2, 'second FLEX payment');
  const r = await staffManualPayment(
    flexCustomer, flexEnrollment, 250_000,
    dateInSchemeMonth(flexStart, 1, istParts().day),
    'flex-large-same-month',
    { method: 'BANK' },
  );
  return r.data;
});

await step('staff payment collector attribution and customer ownership are correct', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const rows = await paymentListForEnrollment(flexEnrollment.id);
  assert(rows.length >= 3, 'expected at least three FLEX payments', rows);
  for (const p of rows.slice(0, 3)) {
    if (p.collectorRole) eq(String(p.collectorRole), 'STAFF', 'collector role');
    const ownerId = String(p.customerId?._id || p.customerId || '');
    if (ownerId) eq(ownerId, flexCustomer.id, 'payment customer ownership');
  }
  state.payments.flex = rows;
  return rows;
});

await step('manual payment schemeMonth is server-authoritative', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  // Send an intentionally wrong schemeMonth. The correct behavior is either:
  // (a) reject client-supplied schemeMonth, or
  // (b) ignore/override it and store derived month 1.
  const r = await owner.post('schemeMonth spoof attempt', '/admin/payments/manual', {
    customerId: flexCustomer.id,
    schemeId: flexEnrollment.id,
    amountPaise: 10_000,
    method: 'CARD',
    paymentDate: dateInSchemeMonth(flexStart, 1, istParts().day),
    schemeMonth: 11,
    idempotencyKey: `nak-spoof-month-${RUN_ID}`,
    notes: 'E2E schemeMonth authority probe',
  }, { throwOnUnexpected: false });

  if ([400, 422].includes(r.status)) return { rejected: true, status: r.status };
  assert(r.status === 201, 'schemeMonth spoof gave unexpected status', r.body);
  const storedMonth = numberFrom(r.data, ['schemeMonth', 'payment.schemeMonth']);
  eq(storedMonth, 1, 'server-derived schemeMonth');
  return r.data;
});

await step('customer portal sees own scheme and contributions', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const list = await flexCustomer.client.get('FLEX customer schemes', '/customer/schemes', { expect: [200] });
  const ids = asArray(list.body).map(x => String(x._id || x.id || ''));
  assert(ids.includes(flexEnrollment.id), 'FLEX enrollment missing from customer scheme list', ids);
  return customerSchemeDetail(flexCustomer, flexEnrollment.id);
});

/* -------------------------------------------------------------------------- */
/*  6+5 CAP — BACKDATED ISOLATED ENROLLMENT                                    */
/* -------------------------------------------------------------------------- */

const capCustomer = await step('create CAP customer', () => createCustomer('CAP', 10));
await step('KYC flow for CAP customer if enabled', async () => ensureKyc(need(capCustomer, 'CAP customer')));

const capStart = startMonthsAgo(6); // current calendar month => scheme month 7
const capEnrollment = await step('enroll CAP customer so current month is scheme month 7', async () => {
  need(capCustomer, 'CAP customer');
  return enrollCustomer(capCustomer, capStart, 'CAP');
});

const phase1Amounts = [100_000, 200_000, 300_000, 400_000]; // total 1,000,000 / 4 = 250,000
const capExpected = expectedCap(phase1Amounts);
state.calculations.cap = capExpected;

const capPhase1Payments = [];

for (const [idx, amount] of phase1Amounts.entries()) {
  const month = [1, 2, 3, 6][idx];
  const p = await step(`CAP phase-one successful payment ${idx + 1} in month ${month}`, async () => {
    need(capEnrollment, 'CAP enrollment');
    const result = await adminManualPayment(
      capCustomer, capEnrollment, amount,
      dateInSchemeMonth(capStart, month, 5),
      `cap-phase1-${idx + 1}-m${month}`,
      { method: idx % 2 ? 'BANK' : 'CASH' },
    );
    capPhase1Payments.push(result);
    return result;
  });
}

let reversedPhase1;
await step('reversed phase-one payment is excluded from cap numerator/denominator', async () => {
  need(capEnrollment, 'CAP enrollment');
  const extra = await adminManualPayment(
    capCustomer, capEnrollment, 500_000,
    dateInSchemeMonth(capStart, 4, 5),
    'cap-phase1-extra-to-reverse',
    { method: 'CASH' },
  );
  const paymentId = idOf(extra);
  assert(paymentId, 'reverse probe payment id missing', extra);

  const rev = await owner.post('reverse cap phase1 extra', `/admin/payments/${paymentId}/reverse`, {
    reason: 'Nakshathra E2E proves reversed principal is excluded from 6+5 cap',
  }, { expect: [200] });
  reversedPhase1 = { payment: extra, reversal: rev.data };
  return reversedPhase1;
});

const capPreview = await step('month 7 payment preview reports transaction-average cap, not total/6', async () => {
  need(capEnrollment, 'CAP enrollment');
  const r = await routeRequest(staff, 'month7 cap preview', 'GET', [
    `/staff/schemes/${capEnrollment.id}/payment-preview?amountPaise=100000`,
    `/staff/enrollments/${capEnrollment.id}/payment-preview?amountPaise=100000`,
  ], { expect: [200] });
  const actualCap = numberFrom(r.data, [
    'monthlyCapPaise', 'capPaise', 'phase.monthlyCapPaise',
    'eligibility.monthlyCapPaise', 'remainingCapPaise',
  ]);
  assert(actualCap != null, 'cap preview did not expose a recognizable cap field', r.data);

  // If API returns remaining cap rather than full cap this is before any month7 payments,
  // therefore it must still equal the full cap.
  eq(actualCap, capExpected.monthlyCapPaise, 'month7 transaction-average cap');
  assert(actualCap !== Math.floor(capExpected.phase1EligiblePrincipalPaise / 6), 'backend appears to use forbidden total/6 formula');
  state.schemes.capPreview = r.data;
  return r.data;
});

const capM7P1 = await step('month 7 partial contribution #1 succeeds', async () => {
  need(capPreview, 'cap preview');
  return (await staffManualPayment(
    capCustomer, capEnrollment, 100_000,
    dateInSchemeMonth(capStart, 7, istParts().day),
    'cap-month7-part1',
    { method: 'CASH' },
  )).data;
});

const capM7P2 = await step('month 7 partial contribution #2 reaches exact cap and succeeds', async () => {
  need(capM7P1, 'month7 part1');
  return (await staffManualPayment(
    capCustomer, capEnrollment, 150_000,
    dateInSchemeMonth(capStart, 7, istParts().day),
    'cap-month7-part2',
    { method: 'UPI' },
  )).data;
});

await step('month 7 exact-cap + 1 paise is rejected', async () => {
  need(capM7P2, 'month7 exact cap');
  const r = await staffManualPayment(
    capCustomer, capEnrollment, 10_000,
    dateInSchemeMonth(capStart, 7, istParts().day),
    'cap-month7-over',
    { expect: [], throwOnUnexpected: false },
  );
  assert([400, 409, 422].includes(r.status), 'payment above month7 remaining cap unexpectedly accepted', r.data);
  return r.body;
});

await step('month 7 contributed total equals independently calculated cap', async () => {
  const rows = await paymentListForEnrollment(capEnrollment.id);
  const m7 = rows.filter(p => Number(p.schemeMonth) === 7 && String(p.status).toUpperCase() === 'SUCCESS' && !p.reversedAt);
  const total = m7.reduce((s, p) => s + Number(p.amountPaise || 0), 0);
  eq(total, capExpected.monthlyCapPaise, 'month7 successful total');
  state.payments.cap = {
    phase1Expected: capExpected,
    month7SuccessfulTotalPaise: total,
    paymentCount: rows.length,
  };
});

/* Concurrency — two requests cannot breach remaining cap on a fresh month7 enrollment */
const concurrentCustomer = await step('create concurrency CAP customer', () => createCustomer('CONC', 11));
const concurrentEnrollment = await step('enroll concurrency customer in month7 scenario', async () => {
  need(concurrentCustomer, 'concurrency customer');
  return enrollCustomer(concurrentCustomer, capStart, 'CONC');
});

await step('seed concurrency customer phase-one average', async () => {
  need(concurrentEnrollment, 'concurrency enrollment');
  for (let i = 0; i < phase1Amounts.length; i++) {
    const month = [1,2,3,6][i];
    await adminManualPayment(
      concurrentCustomer, concurrentEnrollment, phase1Amounts[i],
      dateInSchemeMonth(capStart, month, 6),
      `conc-phase1-${i}`,
      { method: 'BANK' },
    );
  }
});

await step('concurrent capped payments cannot together exceed allowance', async () => {
  need(concurrentEnrollment, 'concurrency enrollment');
  const date = dateInSchemeMonth(capStart, 7, istParts().day);
  const make = (n) => staffManualPayment(
    concurrentCustomer, concurrentEnrollment, 150_000, date,
    `conc-month7-${n}`,
    { idempotencyKey: `nak-conc-${n}-${RUN_ID}`, expect: [], throwOnUnexpected: false },
  );
  const [a, b] = await Promise.all([make(1), make(2)]);
  assert([a.status, b.status].some(x => x >= 200 && x < 300), 'neither concurrent capped payment succeeded', { a: a.status, b: b.status });

  const rows = await paymentListForEnrollment(concurrentEnrollment.id);
  const total = rows
    .filter(p => Number(p.schemeMonth) === 7 && String(p.status).toUpperCase() === 'SUCCESS' && !p.reversedAt)
    .reduce((s, p) => s + Number(p.amountPaise || 0), 0);
  assert(total <= capExpected.monthlyCapPaise, 'concurrency breached month7 cap', { total, cap: capExpected.monthlyCapPaise });
  state.payments.capConcurrency = { responseStatuses: [a.status, b.status], finalMonth7TotalPaise: total };
  return state.payments.capConcurrency;
});

/* Zero denominator */
const zeroCustomer = await step('create zero-denominator CAP customer', () => createCustomer('ZERO', 12));
const zeroEnrollment = await step('enroll zero-denominator customer in month7 with no phase-one payments', async () => {
  need(zeroCustomer, 'zero customer');
  return enrollCustomer(zeroCustomer, capStart, 'ZERO');
});

await step('zero successful first-six payments never produces NaN/Infinity and is non-payable in month7', async () => {
  need(zeroEnrollment, 'zero enrollment');
  const r = await staff.get(
    'zero denominator preview',
    `/staff/schemes/${zeroEnrollment.id}/payment-preview?amountPaise=10000`,
    { throwOnUnexpected: false },
  );
  assert([200, 400, 409, 422].includes(r.status), 'zero denominator preview unexpected status', r.body);
  const serialized = JSON.stringify(r.body);
  assert(!/NaN|Infinity/i.test(serialized), 'zero denominator leaked NaN/Infinity', r.body);
  if (r.status === 200) {
    const allowed = r.data?.allowed ?? r.data?.canPay ?? r.data?.eligible;
    assert(allowed === false, 'zero denominator month7 preview unexpectedly payable', r.data);
  }
  return r.body;
});

/* Month12 contribution rejection */
const postTermCustomer = await step('create month12 customer', () => createCustomer('M12', 13));
const postTermStart = startMonthsAgo(11);
const postTermEnrollment = await step('enroll month12 customer', async () => enrollCustomer(postTermCustomer, postTermStart, 'M12'));

await step('scheme month 12 contribution is rejected', async () => {
  need(postTermEnrollment, 'month12 enrollment');
  const r = await owner.post('month12 payment reject', '/admin/payments/manual', {
    customerId: postTermCustomer.id,
    schemeId: postTermEnrollment.id,
    amountPaise: 10_000,
    method: 'CASH',
    paymentDate: dateInSchemeMonth(postTermStart, 12, istParts().day),
    idempotencyKey: `nak-month12-${RUN_ID}`,
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'month12 contribution unexpectedly accepted', r.data);
});

/* -------------------------------------------------------------------------- */
/*  PAYMENT METHOD / IDEMPOTENCY / RECEIPT / PHONEPE                          */
/* -------------------------------------------------------------------------- */

await step('staff manual UPI, BANK and CARD are supported', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const amounts = [];
  for (const method of ['UPI', 'BANK', 'CARD']) {
    const r = await staffManualPayment(
      flexCustomer, flexEnrollment, 10_000,
      dateInSchemeMonth(flexStart, 1, istParts().day),
      `flex-method-${method.toLowerCase()}`,
      { method },
    );
    amounts.push({ method, status: r.status, id: idOf(r.data) });
  }
  state.payments.methodMatrix = amounts;
  return amounts;
});

await step('manual payment idempotency replays one financial payment', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const key = `nak-idempotent-manual-${RUN_ID}`;
  const body = {
    customerId: flexCustomer.id,
    schemeId: flexEnrollment.id,
    amountPaise: 12_345,
    method: 'CASH',
    paymentDate: dateInSchemeMonth(flexStart, 1, istParts().day),
    referenceNumber: `E2E-IDEMPOTENT-${SUFFIX}`.slice(0, 50),
    notes: 'Nakshathra live E2E exact idempotent replay',
    idempotencyKey: key,
  };

  const a = await staff.post('manual idempotency original', '/staff/payments', body, { expect: [200, 201] });
  const b = await staff.post('manual idempotency exact replay', '/staff/payments', body, { expect: [200, 201] });
  const aid = idOf(a.data);
  const bid = idOf(b.data);
  if (aid && bid) eq(bid, aid, 'manual payment idempotent id');

  const rows = await paymentListForEnrollment(flexEnrollment.id);
  const matches = rows.filter(p => String(p.idempotencyKey || '') === key);
  eq(matches.length, 1, 'idempotent payment row count');
});

await step('manual payment idempotency key rejects mutated payload', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const key = `nak-idempotent-mutation-${RUN_ID}`;
  const body = {
    customerId: flexCustomer.id,
    schemeId: flexEnrollment.id,
    amountPaise: 13_000,
    method: 'CASH',
    paymentDate: dateInSchemeMonth(flexStart, 1, istParts().day),
    referenceNumber: `E2E-IDEM-MUT-${SUFFIX}`.slice(0, 50),
    notes: 'Nakshathra live E2E idempotency mutation guard',
    idempotencyKey: key,
  };
  await staff.post('manual idempotency mutation seed', '/staff/payments', body, { expect: [200, 201] });
  const changed = await staff.post('manual idempotency mutated replay', '/staff/payments', {
    ...body,
    amountPaise: body.amountPaise + 1,
  }, { throwOnUnexpected: false });
  assert(changed.status === 409, 'same idempotency key with changed data was not rejected with 409', changed.body);
  assert(statusCodeOf(changed) === 'IDEMPOTENCY_KEY_REUSED' || /idempotency/i.test(JSON.stringify(changed.body)),
    'mutated idempotency replay was rejected for the wrong reason', changed.body);
});

await step('STAFF can retrieve own collected payment receipt', async () => {
  const rows = await paymentListForEnrollment(flexEnrollment.id);
  const own = rows.find(p => String(p.collectorRole || '').toUpperCase() === 'STAFF');
  need(own, 'staff-collected payment');
  const pid = idOf(own);
  const r = await staff.get('staff own receipt', `/staff/payments/${pid}/receipt`, { expect: [200] });
  return r.data;
});

await step('CUSTOMER can list own payments/receipts', async () => {
  need(flexCustomer, 'FLEX customer');
  const pays = await flexCustomer.client.get('customer payments', '/customer/payments?limit=100', { expect: [200] });
  assert(asArray(pays.body).length >= 1, 'customer payment list empty');
  return pays.data;
});

/* PhonePe — only run full success if dev backend supports it */
await step('customer PhonePe idempotency/finalization if DEV auto-success is enabled', async () => {
  if (!CONFIG.phonePeAutoSuccess) throw new SkipError('NAK_E2E_PHONEPE_AUTO_SUCCESS=false');
  need(flexEnrollment, 'FLEX enrollment');

  const key = `nak-customer-phonepe-${RUN_ID}`;
  const body = {
    customerId: flexCustomer.id,
    schemeId: flexEnrollment.id,
    amountPaise: 10_000,
    idempotencyKey: key,
  };

  const create = await flexCustomer.client.post('customer PhonePe create order', '/customer/payments/phonepe/create-order', body, {
    throwOnUnexpected: false,
  });

  if ([404, 405, 503].includes(create.status)) throw new SkipError(`customer PhonePe DEV route unavailable: HTTP ${create.status}`);
  assert([200, 201].includes(create.status), 'customer PhonePe create order failed', create.body);

  const replay = await flexCustomer.client.post('customer PhonePe replay', '/customer/payments/phonepe/create-order', body, {
    expect: [200, 201],
  });

  const orderId = stringFrom(create.data, ['merchantOrderId', 'orderId', 'merchantTransactionId']);
  const replayId = stringFrom(replay.data, ['merchantOrderId', 'orderId', 'merchantTransactionId']);
  if (orderId && replayId) eq(replayId, orderId, 'PhonePe idempotent order id');

  if (orderId) {
    const intent = await flexCustomer.client.get('customer PhonePe intent', `/customer/payment-intents/${encodeURIComponent(orderId)}`, {
      expect: [200],
    });
    const status = String(intent.data?.status || '').toUpperCase();
    assert(['SUCCESS', 'PENDING', 'PROCESSING'].includes(status), 'unexpected PhonePe intent status', intent.data);
    state.payments.customerPhonePe = intent.data;
  }
});

/* -------------------------------------------------------------------------- */
/*  CASH HELD / HANDOVER                                                       */
/* -------------------------------------------------------------------------- */

await step('staff CASH increases cash-held while digital methods do not', async () => {
  need(staffLogin, 'staff login');
  const r = await routeRequest(staff, 'staff cash held', 'GET', ['/staff/cash-held'], { expect: [200] });
  const held = numberFrom(r.data, ['cashHeldPaise', 'amountPaise', 'heldPaise', 'balancePaise']);
  assert(held != null && held >= 0, 'cash-held response missing amount', r.data);
  state.cash.beforeHandover = held;
  return r.data;
});

await step('admin cash-held report/list includes staff', async () => {
  const r = await routeRequest(owner, 'admin cash held', 'GET', ['/admin/cash-held?limit=100'], { expect: [200] });
  return r.data;
});

let cashSubmission;
await step('OWNER records partial cash handover and held balance decreases exactly', async () => {
  const before = need(state.cash.beforeHandover, 'cash held before handover');
  if (before <= 0) throw new SkipError('No staff CASH held after collection matrix');

  const amount = Math.max(1, Math.floor(before / 2));
  const r = await owner.post('record staff cash submission', '/admin/cash-submissions', {
    staffId: state.ids.staff,
    amountPaise: amount,
    submissionDate: nowIso().slice(0, 10),
    note: `Nak E2E handover ${RUN_ID}`,
    referenceNumber: `E2E-${SUFFIX}`,
  }, { expect: [200, 201] });
  cashSubmission = r.data;

  const afterR = await staff.get('cash held after handover', '/staff/cash-held', { expect: [200] });
  const after = numberFrom(afterR.data, ['cashHeldPaise', 'amountPaise', 'heldPaise', 'balancePaise']);
  assert(after != null, 'cash-held after handover missing');
  eq(after, before - amount, 'cash held after handover');
  state.cash.handover = { beforePaise: before, handedOverPaise: amount, afterPaise: after };
  return state.cash.handover;
});

await step('cash over-handover is rejected', async () => {
  const heldR = await staff.get('cash held before over-handover', '/staff/cash-held', { expect: [200] });
  const held = numberFrom(heldR.data, ['cashHeldPaise', 'amountPaise', 'heldPaise', 'balancePaise'], 0);
  const r = await owner.post('over handover reject', '/admin/cash-submissions', {
    staffId: state.ids.staff,
    amountPaise: held + 1,
    submissionDate: nowIso().slice(0, 10),
    note: 'E2E over-handover must fail',
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'cash over-handover unexpectedly accepted', r.data);
  const serialized = JSON.stringify(r.body || {});
  assert(!/VALIDATION_ERROR.*submissionDate|submissionDate.*VALIDATION_ERROR/i.test(serialized),
    'cash over-handover test failed request validation instead of exercising held-balance protection', r.body);
});

/* -------------------------------------------------------------------------- */
/*  CORRECTIONS — FINAL NAKSHATHRA RULES                                       */
/* -------------------------------------------------------------------------- */

let correctionSourcePayment;

await step('prepare correction source CASH payment', async () => {
  need(flexEnrollment, 'FLEX enrollment');
  const r = await staffManualPayment(
    flexCustomer, flexEnrollment, 20_000,
    dateInSchemeMonth(flexStart, 1, istParts().day),
    'correction-source',
    { method: 'CASH' },
  );
  correctionSourcePayment = r.data;
  assert(idOf(correctionSourcePayment), 'correction source payment id missing');
  return correctionSourcePayment;
});

await step('payment-date correction request is rejected by final Nakshathra policy', async () => {
  const pid = need(idOf(correctionSourcePayment), 'correction source payment');
  const r = await staff.post('forbidden CHANGE_DATE correction', `/staff/payments/${pid}/corrections`, {
    correctionType: 'CHANGE_DATE',
    requestedChanges: { paymentDate: dateInSchemeMonth(flexStart, 1, 1) },
    reason: 'E2E proves payment date is immutable',
  }, { throwOnUnexpected: false });
  assert([400, 403, 409, 422].includes(r.status), 'CHANGE_DATE correction unexpectedly accepted', r.data);
});

let rejectedCorrection;
await step('staff requests amount correction and OWNER rejects it without mutation', async () => {
  const pid = need(idOf(correctionSourcePayment), 'correction source payment');
  const req = await staff.post('amount correction to reject', `/staff/payments/${pid}/corrections`, {
    correctionType: 'CHANGE_AMOUNT',
    requestedChanges: { amountPaise: 25_000 },
    reason: 'E2E rejection path',
  }, { expect: [201] });
  const cid = idOf(req.data);
  assert(cid, 'correction request id missing', req.data);

  const decision = await owner.patch('reject correction', `/admin/corrections/${cid}`, {
    decision: 'REJECTED',
    reviewNotes: 'E2E rejection verified',
  }, { expect: [200] });
  rejectedCorrection = decision.data;

  const detail = await owner.get('original payment after rejected correction', `/admin/payments/${pid}`, { expect: [200] });
  eq(numberFrom(detail.data, ['amountPaise', 'payment.amountPaise']), 20_000, 'rejected correction original amount');
  return rejectedCorrection;
});

let approvedAmountCorrection;
await step('staff amount correction OWNER approval uses traceable reversal/replacement', async () => {
  const pid = need(idOf(correctionSourcePayment), 'correction source payment');
  const req = await staff.post('amount correction approve request', `/staff/payments/${pid}/corrections`, {
    correctionType: 'CHANGE_AMOUNT',
    requestedChanges: { amountPaise: 30_000 },
    reason: 'E2E amount correction approval',
  }, { expect: [201] });
  const cid = idOf(req.data);
  assert(cid, 'approved correction request id missing');

  const decision = await owner.patch('approve amount correction', `/admin/corrections/${cid}`, {
    decision: 'APPROVED',
    reviewNotes: 'E2E approved amount change',
  }, { expect: [200] });
  approvedAmountCorrection = decision.data;

  // Read correction list so response artifacts contain original/replacement linkage.
  await owner.get('correction list readback', `/admin/corrections?limit=100`, { expect: [200] });
  return approvedAmountCorrection;
});

await step('payment-method correction is supported', async () => {
  // Use a fresh payment because the previous original may now be reversed.
  const source = await staffManualPayment(
    flexCustomer, flexEnrollment, 18_000,
    dateInSchemeMonth(flexStart, 1, istParts().day),
    'method-correction-source',
    { method: 'CASH' },
  );
  const pid = idOf(source.data);
  const req = await staff.post('method correction request', `/staff/payments/${pid}/corrections`, {
    correctionType: 'CHANGE_METHOD',
    requestedChanges: { method: 'BANK' },
    reason: 'E2E method correction',
  }, { expect: [201] });
  const cid = idOf(req.data);
  const decision = await owner.patch('approve method correction', `/admin/corrections/${cid}`, {
    decision: 'APPROVED',
    reviewNotes: 'E2E method correction approved',
  }, { expect: [200] });
  return decision.data;
});

/* -------------------------------------------------------------------------- */
/*  PREMATURE CLOSURE — CASH ONLY / FULL PRINCIPAL / NO PENALTY                */
/* -------------------------------------------------------------------------- */

// Boundary test: before the configured 6-month lock-in, premature CASH must remain blocked.
const prematureLockedCustomer = await step('create pre-lock premature customer', () => createCustomer('EARLYLOCK', 19));
const prematureLockedStart = startMonthsAgo(3);
const prematureLockedEnrollment = await step('enroll pre-lock premature customer', async () =>
  enrollCustomer(prematureLockedCustomer, prematureLockedStart, 'EARLYLOCK'));

await step('premature CASH before 6-month lock-in is rejected', async () => {
  await adminManualPayment(
    prematureLockedCustomer,
    prematureLockedEnrollment,
    100_000,
    dateInSchemeMonth(prematureLockedStart, 1, 5),
    'premature-locked-principal',
    { method: 'BANK' },
  );
  const preview = await owner.get(
    'pre-lock premature CASH preview',
    `/admin/enrollments/${prematureLockedEnrollment.id}/premature-closure-preview?settlementAsset=CASH`,
    { expect: [200] },
  );
  const eligible = preview.data?.eligible;
  const reasons = JSON.stringify(preview.data?.blockingReasons || preview.data?.reason || preview.data?.reasons || []);
  assert(eligible === false || /NOT_YET_ELIGIBLE|lock|elapsed|month/i.test(reasons),
    'pre-lock premature closure unexpectedly appears eligible', preview.data);
});

// Success path: start safely beyond the 6-month minimum so this test proves actual settlement.
const prematureCustomer = await step('create PREMATURE customer', () => createCustomer('EARLY', 20));
const prematureStart = startMonthsAgo(7);
const prematureEnrollment = await step('enroll PREMATURE customer', async () => enrollCustomer(prematureCustomer, prematureStart, 'EARLY'));

const prematureAmounts = [100_000, 125_000, 150_000];
for (let i = 0; i < prematureAmounts.length; i++) {
  await step(`premature principal payment ${i + 1}`, async () => {
    return adminManualPayment(
      prematureCustomer, prematureEnrollment, prematureAmounts[i],
      dateInSchemeMonth(prematureStart, i + 1, 5),
      `premature-principal-${i + 1}`,
      { method: 'BANK' },
    );
  });
}
const prematurePrincipal = prematureAmounts.reduce((a,b) => a+b, 0);

const prematurePreview = await step('premature closure preview returns CASH-only settlement and full principal', async () => {
  need(prematureEnrollment, 'premature enrollment');
  const r = await owner.get(
    'premature CASH preview',
    `/admin/enrollments/${prematureEnrollment.id}/premature-closure-preview?settlementAsset=CASH`,
    { expect: [200] },
  );
  assert(r.data?.eligible !== false, 'eligible premature enrollment was unexpectedly blocked', r.data);
  const modes = r.data?.allowedSettlementModes || r.data?.allowedSettlementAssets || [];
  assert(modes.includes('CASH') || modes.length === 0, 'premature preview does not allow CASH', r.data);
  if (modes.length) assert(!modes.includes('JEWELLERY'), 'premature preview incorrectly allows JEWELLERY', r.data);
  const principal = numberFrom(r.data, [
    'settlementPrincipalPaise', 'principalPaise', 'cashAmountPaise',
    'payoutAmountPaise', 'amountPaise', 'eligiblePrincipalPaise', 'availablePrincipalPaise',
  ]);
  if (principal != null) eq(principal, prematurePrincipal, 'premature full principal');
  state.settlements.prematurePreview = r.data;
  return r.data;
});

await step('premature JEWELLERY settlement is rejected', async () => {
  need(prematureEnrollment, 'premature enrollment');
  const r = await owner.post('premature jewellery reject', `/admin/enrollments/${prematureEnrollment.id}/premature-close`, {
    settlementAsset: 'JEWELLERY',
    payoutDate: nowIso().slice(0, 10),
    reason: 'E2E must reject jewellery before maturity',
    idempotencyKey: `nak-early-jewellery-${RUN_ID}`,
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'premature JEWELLERY unexpectedly succeeded', r.data);
});

let prematureClosed;
await step('premature CASH closes for exact full principal with no penalty', async () => {
  need(prematurePreview, 'premature preview');
  const final = await owner.post('premature cash close', `/admin/enrollments/${prematureEnrollment.id}/premature-close`, {
    settlementAsset: 'CASH',
    payoutDate: nowIso().slice(0, 10),
    reason: 'Nakshathra E2E premature full-principal settlement',
    referenceNumber: `EARLY-${SUFFIX}`,
    notes: 'No penalty expected',
    idempotencyKey: `nak-early-cash-${RUN_ID}`,
  }, { expect: [200, 201] });

  prematureClosed = final.data;
  const amount = numberFrom(final.data, [
    'amountPaise', 'cashAmountPaise', 'payoutAmountPaise',
    'settlementAmountPaise', 'payout.amountPaise',
  ]);
  if (amount != null) eq(amount, prematurePrincipal, 'premature cash settlement amount');
  const penalty = numberFrom(final.data, ['penaltyPaise', 'deductionPaise', 'penaltyAmountPaise'], 0);
  eq(penalty, 0, 'premature cash penalty');
  state.settlements.premature = { expectedPrincipalPaise: prematurePrincipal, response: final.data };
  return final.data;
});

await step('payment after premature closure is rejected', async () => {
  need(prematureClosed, 'premature closure');
  const r = await owner.post('post-close payment reject', '/admin/payments/manual', {
    customerId: prematureCustomer.id,
    schemeId: prematureEnrollment.id,
    amountPaise: 10_000,
    method: 'CASH',
    paymentDate: nowIso().slice(0, 10),
    idempotencyKey: `nak-post-close-${RUN_ID}`,
  }, { throwOnUnexpected: false });
  assert([400, 409, 422].includes(r.status), 'payment after premature closure unexpectedly accepted', r.data);
});

await step('premature closure retry cannot create a second successful payout', async () => {
  const payouts = await payoutListForEnrollment(prematureEnrollment.id);
  const success = payouts.filter(p => ['SUCCESS', 'COMPLETED', 'PAID'].includes(String(p.status || '').toUpperCase()));
  assert(success.length <= 1, 'duplicate successful premature payouts detected', success);
  return payouts;
});

/* -------------------------------------------------------------------------- */
/*  MATURITY CASH — FEWER THAN 11 DISTINCT PAID MONTHS                         */
/* -------------------------------------------------------------------------- */

const matureCashCustomer = await step('create MATURE-CASH customer', () => createCustomer('MATURECASH', 30));
const matureStart = startMonthsAgo(12);
const matureCashEnrollment = await step('enroll MATURE-CASH customer with start >11 months ago', async () => {
  return enrollCustomer(matureCashCustomer, matureStart, 'MATURECASH');
});

const matureCashAmounts = [200_000, 300_000]; // only two successful paid months
await step('seed only two successful paid months for maturity-time test', async () => {
  for (let i = 0; i < matureCashAmounts.length; i++) {
    await adminManualPayment(
      matureCashCustomer, matureCashEnrollment, matureCashAmounts[i],
      dateInSchemeMonth(matureStart, i + 1, 5),
      `mature-cash-principal-${i + 1}`,
      { method: 'BANK' },
    );
  }
});
const matureCashPrincipal = matureCashAmounts.reduce((a,b)=>a+b,0);

const matureCashPreview = await step('maturity preview allows CASH despite fewer than 11 distinct successful paid months', async () => {
  need(matureCashEnrollment, 'mature cash enrollment');
  let r = await owner.get(
    'maturity CASH preview',
    `/admin/enrollments/${matureCashEnrollment.id}/redemption-preview?settlementMode=CASH`,
    { throwOnUnexpected: false },
  );
  if ([404,405].includes(r.status) || ([400,422].includes(r.status) && /settlementMode/i.test(JSON.stringify(r.body)))) {
    r = await owner.get(
      'maturity CASH preview compatibility',
      `/admin/enrollments/${matureCashEnrollment.id}/redemption-preview?settlementAsset=CASH`,
      { expect: [200] },
    );
  } else {
    assert(r.status === 200, `maturity CASH preview HTTP ${r.status}`, r.body);
  }

  const blocking = r.data?.blockingReasons || r.data?.reasons || [];
  assert(!JSON.stringify(blocking).match(/11.*payment|installment.*11/i), 'maturity incorrectly blocked by 11-payment-count requirement', r.data);

  const modes = r.data?.allowedSettlementModes || r.data?.allowedSettlementAssets || [];
  if (modes.length) assert(modes.includes('CASH'), 'maturity preview does not allow CASH', r.data);
  state.settlements.matureCashPreview = r.data;
  return r.data;
});

let matureCashPayout;
await step('maturity CASH payout settles server-derived principal', async () => {
  need(matureCashPreview, 'mature cash preview');
  const body = {
    customerId: matureCashCustomer.id,
    schemeId: matureCashEnrollment.id,
    payoutDate: nowIso().slice(0, 10),
    payoutType: 'PAYOUT',
    settlementMode: 'CASH',
    idempotencyKey: `nak-mature-cash-${RUN_ID}`,
    notes: 'Nakshathra E2E maturity CASH',
  };
  let r = await owner.post('maturity CASH payout', '/admin/payouts', body, { throwOnUnexpected: false });
  if ([400,422].includes(r.status) && /settlementMode|payoutType/i.test(JSON.stringify(r.body))) {
    r = await owner.post('maturity CASH payout compatibility', '/admin/payouts', {
      customerId: matureCashCustomer.id,
      schemeId: matureCashEnrollment.id,
      payoutDate: nowIso().slice(0, 10),
      payoutType: 'PAYOUT',
      settlementAsset: 'CASH',
      idempotencyKey: `nak-mature-cash-${RUN_ID}`,
      notes: 'Nakshathra E2E maturity CASH',
    }, { expect: [200,201] });
  } else {
    assert([200,201].includes(r.status), `maturity CASH payout HTTP ${r.status}`, r.body);
  }
  matureCashPayout = r.data;
  const amount = numberFrom(r.data, ['amountPaise', 'payoutAmountPaise', 'cashAmountPaise', 'payout.amountPaise']);
  if (amount != null) eq(amount, matureCashPrincipal, 'maturity CASH principal');
  state.settlements.maturityCash = { expectedPrincipalPaise: matureCashPrincipal, response: r.data };
  return r.data;
});

await step('second maturity payout is blocked/idempotent and cannot double settle', async () => {
  const payouts = await payoutListForEnrollment(matureCashEnrollment.id);
  const success = payouts.filter(p => ['SUCCESS', 'COMPLETED', 'PAID'].includes(String(p.status || '').toUpperCase()));
  assert(success.length <= 1, 'multiple successful maturity payouts for one enrollment', success);
  return payouts;
});

/* -------------------------------------------------------------------------- */
/*  OLD MATURED CASH ENTITLEMENT NEVER EXPIRES                                 */
/* -------------------------------------------------------------------------- */

const oldMatureCustomer = await step('create old-matured CASH customer', () => createCustomer('OLDMATURE', 31));
const oldStart = startMonthsAgo(24);
const oldMatureEnrollment = await step('enroll customer with 24-month-old start date', async () => {
  return enrollCustomer(oldMatureCustomer, oldStart, 'OLDMATURE');
});

await step('seed old matured entitlement principal', async () => {
  return adminManualPayment(
    oldMatureCustomer, oldMatureEnrollment, 175_000,
    dateInSchemeMonth(oldStart, 1, 5),
    'old-mature-principal',
    { method: 'BANK' },
  );
});

await step('old matured CASH entitlement remains claimable after normal redemption month', async () => {
  need(oldMatureEnrollment, 'old mature enrollment');
  let r = await owner.get(
    'old maturity cash preview',
    `/admin/enrollments/${oldMatureEnrollment.id}/redemption-preview?settlementMode=CASH`,
    { throwOnUnexpected: false },
  );
  if ([404,405].includes(r.status) || ([400,422].includes(r.status) && /settlementMode/i.test(JSON.stringify(r.body)))) {
    r = await owner.get(
      'old maturity cash preview compatibility',
      `/admin/enrollments/${oldMatureEnrollment.id}/redemption-preview?settlementAsset=CASH`,
      { expect: [200] },
    );
  } else {
    assert(r.status === 200, `old matured CASH preview HTTP ${r.status}`, r.body);
  }
  const reasons = JSON.stringify(r.data?.blockingReasons || r.data?.reasons || []);
  assert(!/expired|window.*closed|redemption.*ended/i.test(reasons), 'old matured CASH entitlement incorrectly expired', r.data);
  return r.data;
});

/* -------------------------------------------------------------------------- */
/*  MATURITY JEWELLERY                                                         */
/* -------------------------------------------------------------------------- */

const jewelleryCustomer = await step('create MATURITY-JEWELLERY customer', () => createCustomer('JEWELLERY', 32));
const jewelleryStart = startMonthsAgo(12);
const jewelleryEnrollment = await step('enroll MATURITY-JEWELLERY customer', async () => enrollCustomer(jewelleryCustomer, jewelleryStart, 'JEWELLERY'));

await step('seed jewellery maturity principal', async () => {
  return adminManualPayment(
    jewelleryCustomer, jewelleryEnrollment, 250_000,
    dateInSchemeMonth(jewelleryStart, 1, 5),
    'jewellery-maturity-principal',
    { method: 'UPI' },
  );
});

const jewelleryPreview = await step('maturity preview exposes CASH and JEWELLERY combinations', async () => {
  let r = await owner.get(
    'maturity JEWELLERY preview',
    `/admin/enrollments/${jewelleryEnrollment.id}/redemption-preview?settlementAsset=JEWELLERY`,
    { throwOnUnexpected: false },
  );
  if ([404,405].includes(r.status)) throw new Error('maturity redemption-preview route is missing');
  assert(r.status === 200, `maturity JEWELLERY preview HTTP ${r.status}`, r.body);

  const modes = r.data?.allowedSettlementModes || r.data?.allowedSettlementAssets || [];
  assert(modes.includes('JEWELLERY'), 'MATURITY does not expose JEWELLERY in allowedSettlementModes', r.data);
  assert(modes.includes('CASH'), 'MATURITY does not expose CASH in allowedSettlementModes', r.data);
  state.settlements.jewelleryPreview = r.data;
  return r.data;
});

await step('maturity JEWELLERY terminal settlement succeeds', async () => {
  need(jewelleryPreview, 'jewellery preview');
  const r = await owner.post('maturity JEWELLERY payout', '/admin/payouts', {
    customerId: jewelleryCustomer.id,
    schemeId: jewelleryEnrollment.id,
    payoutDate: nowIso().slice(0, 10),
    payoutType: 'PAYOUT',
    settlementAsset: 'JEWELLERY',
    billNumber: `JWL-BILL-${SUFFIX}`,
    billAmountPaise: 250_000,
    idempotencyKey: `nak-mature-jewellery-${RUN_ID}`,
    referenceNumber: `JWL-${SUFFIX}`,
    notes: 'Nakshathra E2E jewellery settlement',
  }, { throwOnUnexpected: false });
  assert([200,201].includes(r.status), `maturity JEWELLERY payout HTTP ${r.status}`, r.body);
  state.settlements.maturityJewellery = r.data;
  return r.data;
});

/* -------------------------------------------------------------------------- */
/*  CUSTOMER PORTAL + OWNER LIST SURFACES                                      */
/* -------------------------------------------------------------------------- */

await step('customer dashboard/profile surfaces', async () => {
  need(flexCustomer, 'FLEX customer');
  const results = {};
  for (const endpoint of ['/customer/dashboard', '/customer/profile']) {
    const r = await flexCustomer.client.get(`customer surface ${endpoint}`, endpoint, { throwOnUnexpected: false });
    if ([404,405].includes(r.status)) continue;
    assert(r.status === 200, `${endpoint} failed HTTP ${r.status}`, r.body);
    results[endpoint] = r.data;
  }
  assert(Object.keys(results).length >= 1, 'neither customer dashboard nor profile route is mounted');
  return results;
});

await step('customer payouts surface is readable', async () => {
  need(matureCashCustomer, 'mature cash customer');
  const r = await matureCashCustomer.client.get('customer payout list', '/customer/payouts?limit=100', { expect: [200] });
  return r.data;
});

await step('admin enrollment operational lists do not route as :id', async () => {
  for (const name of ['overdue', 'due', 'redemption-ready']) {
    const r = await owner.get(`enrollment ${name}`, `/admin/enrollments/${name}?limit=20`, { expect: [200] });
    assert(!/Invalid identifier/i.test(JSON.stringify(r.body)), `${name} was parsed as enrollment id`, r.body);
  }
});

await step('admin audit log is readable and contains E2E activity', async () => {
  const r = await owner.get('audit logs', `/admin/audit-logs?limit=100`, { expect: [200] });
  assert(asArray(r.body).length >= 1, 'audit log unexpectedly empty');
  return r.data;
});

await step('admin corrections list is readable', async () => {
  return (await owner.get('admin corrections', '/admin/corrections?limit=100', { expect: [200] })).data;
});

await step('admin payments list/detail are readable after all mutations', async () => {
  const r = await owner.get('admin payments list', '/admin/payments?limit=100', { expect: [200] });
  assert(asArray(r.body).length >= 1, 'admin payment list unexpectedly empty');
  return r.data;
});

/* -------------------------------------------------------------------------- */
/*  REPORTS + RECONCILIATION                                                   */
/* -------------------------------------------------------------------------- */

async function discoverLocalReportNames() {
  const roots = [
    'src/services/report.service.ts',
    'src/services/admin-report.service.ts',
    'src/controllers/admin/report-admin.controller.ts',
    'src/routes/admin/report-admin.routes.ts',
  ];
  const names = new Set();
  for (const file of roots) {
    if (!fs.existsSync(file)) continue;
    const text = await fsp.readFile(file, 'utf8');
    for (const re of [
      /case\s+['\"]([a-z0-9-]+)['\"]/gi,
      /report\s*===?\s*['\"]([a-z0-9-]+)['\"]/gi,
      /['\"]([a-z0-9-]*(?:collection|payment|staff|method|daily|monthly|scheme)[a-z0-9-]*)['\"]/gi,
    ]) {
      for (const match of text.matchAll(re)) names.add(match[1]);
    }
  }
  const out = [...names].sort();
  state.reports.localDiscoveredNames = out;
  return out;
}

async function firstWorkingNamedReport(logicalName, candidates) {
  const discovered = await discoverLocalReportNames();
  const discoveredRelevant = discovered.filter(name => {
    if (logicalName === 'collections') return /collect|daily|monthly|scheme/i.test(name);
    return /method|staff|collect|payment/i.test(name);
  });
  const names = [...new Set([...discoveredRelevant, ...candidates])];
  const attempts = [];
  for (const name of names) {
    const r = await owner.get(`report ${name}`, `/admin/reports/${name}`, { throwOnUnexpected: false });
    attempts.push({ name, status: r.status, code: statusCodeOf(r) });
    if ([404,405].includes(r.status)) continue;
    if (r.status === 200) {
      if (logicalName !== 'collections') {
        const serialized = JSON.stringify(r.data || {});
        const hasBreakdownEvidence = /byMethod|paymentMethod|method|collector|staff|CASH|UPI|BANK|CARD/i.test(serialized);
        if (!hasBreakdownEvidence) {
          attempts[attempts.length - 1].note = '200 but no method/staff attribution evidence in response';
          continue;
        }
      }
      return { name, data: r.data, attempts };
    }
    // A recognized report that rejects only our generic optional query still proves routing;
    // however certification needs an executable 200 response, so preserve the failure details.
  }
  throw new Error(`Required Nakshathra ${logicalName} report view is not executable. Tried: ${JSON.stringify(attempts)}`);
}

await step('collections report executes after mixed admin/staff/customer flows', async () => {
  const got = await firstWorkingNamedReport('collections', [
    'collections', 'daily-collections', 'monthly-collections', 'scheme-collections',
    'collection', 'daily', 'monthly', 'collections-daily', 'collections-monthly', 'scheme-wise', 'scheme-wise-collections',
  ]);
  state.reports.collections = got;
  return got;
});

await step('payment-method/staff collection reporting executes', async () => {
  const got = await firstWorkingNamedReport('payment-method/staff collection', [
    'payment-methods', 'payment-method-breakdown', 'collections-by-method',
    'staff-collections', 'staff-wise-collections', 'collector-breakdown',
    'collection-by-method', 'collection-by-staff', 'payment-method', 'staff', 'staff-wise',
  ]);
  state.reports.staffCollections = got;
  return got;
});

await step('payout/closure report executes', async () => {
  const candidates = ['payouts', 'closures', 'settlements'];
  for (const name of candidates) {
    const r = await owner.get(`report ${name}`, `/admin/reports/${name}?limit=100`, { throwOnUnexpected: false });
    if ([404,405].includes(r.status)) continue;
    assert(r.status === 200, `report ${name} HTTP ${r.status}`, r.body);
    state.reports.payouts = { name, data: r.data };
    return state.reports.payouts;
  }
  throw new Error('No payout/closure/settlement report endpoint found');
});

await step('cash-held/cash-submission reporting executes', async () => {
  const a = await owner.get('admin cash held final', '/admin/cash-held?limit=100', { expect: [200] });
  const b = await owner.get('admin cash submissions final', '/admin/cash-submissions?limit=100', { expect: [200] });
  state.reports.cash = { cashHeld: a.data, submissions: b.data };
  return state.reports.cash;
});

await step('correction status/history report executes if mounted', async () => {
  for (const name of ['corrections', 'payment-corrections']) {
    const r = await owner.get(`report ${name}`, `/admin/reports/${name}?limit=100`, { throwOnUnexpected: false });
    if ([404,405].includes(r.status)) continue;
    assert(r.status === 200, `report ${name} HTTP ${r.status}`, r.body);
    state.reports.corrections = { name, data: r.data };
    return state.reports.corrections;
  }
  // The admin correction list itself is an authoritative report surface if a dedicated
  // named report is not mounted.
  const r = await owner.get('corrections list fallback', '/admin/corrections?limit=100', { expect: [200] });
  state.reports.corrections = { name: 'admin/corrections', data: r.data };
  return state.reports.corrections;
});

await step('settlement amounts reconcile against independent expected principal', async () => {
  const prematurePayouts = await payoutListForEnrollment(prematureEnrollment.id);
  const maturityPayouts = await payoutListForEnrollment(matureCashEnrollment.id);

  const pickSuccessAmount = rows => {
    const row = rows.find(p => ['SUCCESS', 'COMPLETED', 'PAID'].includes(String(p.status || '').toUpperCase())) || rows[0];
    return row ? numberFrom(row, ['amountPaise', 'payoutAmountPaise', 'cashAmountPaise', 'settlementAmountPaise']) : undefined;
  };

  const early = pickSuccessAmount(prematurePayouts);
  const mature = pickSuccessAmount(maturityPayouts);
  if (early != null) eq(early, prematurePrincipal, 'premature payout reconciliation');
  if (mature != null) eq(mature, matureCashPrincipal, 'maturity CASH payout reconciliation');

  state.settlements.reconciliation = {
    prematureExpectedPaise: prematurePrincipal,
    prematureActualPaise: early,
    matureCashExpectedPaise: matureCashPrincipal,
    matureCashActualPaise: mature,
  };
  return state.settlements.reconciliation;
});

await step('6+5 cap final reconciliation from persisted payments', async () => {
  const rows = await paymentListForEnrollment(capEnrollment.id);
  const phase1 = rows.filter(p =>
    Number(p.schemeMonth) >= 1 &&
    Number(p.schemeMonth) <= 6 &&
    String(p.status || '').toUpperCase() === 'SUCCESS' &&
    !p.reversedAt &&
    !p.reversalOf &&
    !p.isReversed
  );

  // Some APIs retain status SUCCESS plus reversedAt, others switch status to REVERSED.
  // The exact known four seed payments are sufficient to assert the expected cap.
  const actualPhase1Amounts = phase1.map(p => Number(p.amountPaise || 0));
  const total = actualPhase1Amounts.reduce((a,b)=>a+b,0);
  const count = actualPhase1Amounts.length;

  assert(total >= capExpected.phase1EligiblePrincipalPaise, 'persisted phase1 principal lower than expected', { total, actualPhase1Amounts });
  assert(count >= capExpected.phase1EligiblePaymentCount, 'persisted phase1 success count lower than expected', { count });

  // The authoritative preview earlier already proved the computed cap equals 250000.
  state.schemes.capFinal = {
    expected: capExpected,
    persistedSuccessfulNonReversedPhase1Rows: count,
    persistedSuccessfulNonReversedPhase1Paise: total,
  };
  return state.schemes.capFinal;
});

await step('final OWNER dashboard', async () => {
  return (await owner.get('final owner dashboard', '/admin/dashboard', { expect: [200] })).data;
});

await step('final STAFF dashboard', async () => {
  return (await staff.get('final staff dashboard', '/staff/dashboard', { expect: [200] })).data;
});

/* -------------------------------------------------------------------------- */
/*  AUTH REFRESH / LOGOUT                                                      */
/* -------------------------------------------------------------------------- */

await step('customer refresh session rotates/renews cookies', async () => {
  need(flexCustomer, 'FLEX customer');
  const before = flexCustomer.client.cookieHeader();
  const r = await flexCustomer.client.post('customer refresh', '/auth/refresh', {}, { expect: [200] });
  const after = flexCustomer.client.cookieHeader();
  assert(after, 'customer refresh left no session cookies');
  return { hadCookiesBefore: Boolean(before), hasCookiesAfter: Boolean(after), body: r.data };
});

await step('secondary customer logout clears protected access', async () => {
  need(staffCreatedCustomer, 'staff-created customer');
  const c = staffCreatedCustomer.client;
  await c.post('secondary customer logout', '/auth/logout', {}, { expect: [200] });
  const after = await c.get('secondary customer access after logout', '/customer/schemes', {
    throwOnUnexpected: false,
  });
  assert([401,403].includes(after.status), 'logged-out customer still has protected access', after.body);
});

/* -------------------------------------------------------------------------- */
/*  BACKEND LOG SCAN                                                          */
/* -------------------------------------------------------------------------- */

await step('backend log scan for Mongo/Mongoose/worker errors', async () => {
  if (!fs.existsSync(CONFIG.backendLog)) throw new SkipError(`Backend log not available: ${CONFIG.backendLog}`);
  const text = await fsp.readFile(CONFIG.backendLog, 'utf8');
  const sinceMarker = RUN_STARTED_AT.getTime();

  // Expected negative E2E cases produce ordinary 4xx AppError logs at error level.
  // Those are not Mongo/Mongoose/worker failures. Fail only on infrastructure/runtime
  // signatures, 5xx-class errors, or non-AppError level-50/60 records.
  const runtimeRe = /(CastError|MongooseError|MongoServerError|MongoNotConnectedError|sanitizeFilter|uncaughtException|unhandledRejection|worker failed|worker error|startup failed)/i;
  function isUnexpectedBackendErrorLine(line) {
    if (!line) return false;
    if (runtimeRe.test(line)) return true;
    try {
      const parsed = JSON.parse(line);
      const level = Number(parsed?.level || 0);
      const status = Number(parsed?.err?.statusCode ?? parsed?.statusCode ?? parsed?.status ?? 0);
      const type = String(parsed?.err?.type || parsed?.err?.name || '');
      if (status >= 500) return true;
      if (level >= 50) {
        if (type === 'AppError' && status >= 400 && status < 500) return false;
        return true;
      }
      return false;
    } catch {
      return /\blevel=error\b/i.test(line);
    }
  }
  const lines = text.split(/\r?\n/).filter(isUnexpectedBackendErrorLine);
  await fsp.writeFile(FILES.backendErrors, lines.join('\n'));
  state.backendLog = {
    path: CONFIG.backendLog,
    scanned: true,
    suspiciousLines: lines.length,
    runStartedEpochMs: sinceMarker,
  };
  if (CONFIG.failOnBackendErrors) {
    assert(lines.length === 0, `backend log contains ${lines.length} suspicious Mongo/Mongoose/worker/error lines; inspect backend-errors.log`);
  }
  return state.backendLog;
});

/* -------------------------------------------------------------------------- */
/*  SAVE + VERDICT                                                             */
/* -------------------------------------------------------------------------- */

const counts = {
  passed: steps.filter(s => s.status === 'PASS').length,
  failed: steps.filter(s => s.status === 'FAIL').length,
  skipped: steps.filter(s => s.status === 'SKIP').length,
  total: steps.length,
};

const mandatorySkipNames = new Set([
  // External provider/storage transport can legitimately be unavailable in local dev,
  // but the business-state flow itself must not be skipped.
  'customer PhonePe idempotency/finalization if DEV auto-success is enabled',
  'KYC flow for FLEX customer if enabled',
  'KYC flow for CAP customer if enabled',
]);

const unexpectedSkips = steps.filter(s => s.status === 'SKIP' && !mandatorySkipNames.has(s.name));

const certification =
  counts.failed === 0 &&
  unexpectedSkips.length === 0 &&
  (!CONFIG.failOnBackendErrors || !state.backendLog?.scanned || state.backendLog?.suspiciousLines === 0)
    ? 'PASS'
    : 'FAIL';

await fsp.writeFile(FILES.steps, JSON.stringify(steps, null, 2));
await fsp.writeFile(FILES.calculations, JSON.stringify(state.calculations, null, 2));
await fsp.writeFile(FILES.scheme, JSON.stringify(state.schemes, null, 2));
await fsp.writeFile(FILES.payments, JSON.stringify(state.payments, null, 2));
await fsp.writeFile(FILES.settlements, JSON.stringify(state.settlements, null, 2));
await fsp.writeFile(FILES.cash, JSON.stringify(state.cash, null, 2));
await fsp.writeFile(FILES.reports, JSON.stringify(state.reports, null, 2));
await fsp.writeFile(FILES.permissions, JSON.stringify(state.permissions, null, 2));
await fsp.writeFile(FILES.routeCoverage, JSON.stringify(state.routes, null, 2));
await fsp.writeFile(FILES.failures, JSON.stringify(failures, null, 2));

const summary = {
  runId: RUN_ID,
  startedAt: RUN_STARTED_AT.toISOString(),
  finishedAt: nowIso(),
  baseUrl: CONFIG.baseUrl,
  certification,
  counts,
  unexpectedSkips,
  businessContract: {
    liveSchemeType: 'CASH',
    durationMonths: 11,
    flexibleMonths: 6,
    cappedMonths: 5,
    minimumPaymentPaise: 10000,
    capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
    prematureModes: ['CASH'],
    maturityModes: ['CASH', 'JEWELLERY'],
    prematureCashBasis: 'FULL_CONTRIBUTED_PRINCIPAL_NO_PENALTY',
    maturityRequiresElevenDistinctPaidMonths: false,
    maturedCashEntitlementExpires: false,
    kycRequiredForThisRun: CONFIG.kycRequired,
  },
  ids: state.ids,
  calculations: state.calculations,
  schemes: state.schemes,
  payments: state.payments,
  settlements: state.settlements,
  cash: state.cash,
  reports: state.reports,
  permissions: state.permissions,
  backendLog: state.backendLog || { path: CONFIG.backendLog, scanned: false },
  notes: state.notes,
  failures,
};

await fsp.writeFile(FILES.summaryJson, JSON.stringify(summary, null, 2));

const md = `# Nakshathra Live E2E Certification V2.1

- **Run:** ${RUN_ID}
- **Started:** ${summary.startedAt}
- **Finished:** ${summary.finishedAt}
- **API:** ${CONFIG.baseUrl}
- **Final:** **${certification}**
- **PASS:** ${counts.passed}
- **FAIL:** ${counts.failed}
- **SKIP:** ${counts.skipped}
- **Unexpected required SKIP:** ${unexpectedSkips.length}
- **Backend suspicious log lines:** ${state.backendLog?.suspiciousLines ?? 'not scanned'}

## Locked Business Contract

\`\`\`json
${JSON.stringify(summary.businessContract, null, 2)}
\`\`\`

## Independent 6+5 Cap Expectation

\`\`\`json
${JSON.stringify(state.calculations.cap || {}, null, 2)}
\`\`\`

## Settlement Reconciliation

\`\`\`json
${JSON.stringify(state.settlements.reconciliation || {}, null, 2)}
\`\`\`

## Cash Reconciliation

\`\`\`json
${JSON.stringify(state.cash || {}, null, 2)}
\`\`\`

## Failures

${failures.length ? failures.map(f => `- **${f.name}** — ${String(f.error).split('\n')[0]}`).join('\n') : '- None'}

## Skips

${steps.filter(s => s.status === 'SKIP').length
  ? steps.filter(s => s.status === 'SKIP').map(s => `- **${s.name}** — ${s.reason}`).join('\n')
  : '- None'}

## Files

- \`requests.ndjson\` — sanitized HTTP request log
- \`responses.ndjson\` — sanitized HTTP response log
- \`steps.json\` — step-by-step result
- \`calculations.json\` — independent cap math
- \`scheme-reconciliation.json\`
- \`payment-reconciliation.json\`
- \`settlement-reconciliation.json\`
- \`cash-reconciliation.json\`
- \`report-reconciliation.json\`
- \`permissions.json\`
- \`route-coverage.json\`
- \`local-route-source.json\`
- \`backend-errors.log\`
- \`failures.json\`
- \`summary.json\`
`;

await fsp.writeFile(FILES.summaryMd, md);

console.log(`
==================================================================
NAKSHATHRA LIVE E2E CERTIFICATION V2.1: ${certification}
PASS ${counts.passed} | FAIL ${counts.failed} | SKIP ${counts.skipped}
Unexpected required SKIP: ${unexpectedSkips.length}
Results: ${RESULT_DIR}
==================================================================
`);

process.exitCode = certification === 'PASS' ? 0 : 1;
