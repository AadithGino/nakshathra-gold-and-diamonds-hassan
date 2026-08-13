import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { User } from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { parseAppEnv } from '../src/config/env.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

async function readSrc(relativeFromTest: string) {
  return readFile(new URL(relativeFromTest, import.meta.url), 'utf8');
}

describe('final production regression audit — coverage gaps', () => {
  it('mounts the staff portal and staff-admin HTTP routers with cash-submission admin routes', async () => {
    const apiRoutes = await readSrc('../src/routes/index.ts');
    const adminRoutes = await readSrc('../src/routes/admin/index.ts');
    const financeRoutes = await readSrc('../src/routes/admin/finance-admin.routes.ts');
    const appSource = await readSrc('../src/app.ts');

    expect(apiRoutes).toMatch("'/staff'");
    expect(adminRoutes).toMatch('staffAdminRouter');
    expect(appSource).not.toMatch('/staff');
    expect(financeRoutes).toMatch("'/cash-submissions'");
    expect(financeRoutes).toMatch('createCashSubmissionHandler');
    expect(financeRoutes).toMatch('listCashSubmissionsHandler');
    expect(financeRoutes).toMatch("'/cash-held'");
  });

  it('keeps production autoIndex off and COOKIE_SECURE required', async () => {
    const database = await readSrc('../src/config/database.ts');
    expect(database).toMatch(/autoIndex: env\.NODE_ENV !== 'production'/);

    const parsed = parseAppEnv({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/kairali',
      WEB_ORIGINS: 'https://admin.example.com',
      JWT_ACCESS_SECRET: 'prod-access-secret-at-least-32-chars!!',
      JWT_REFRESH_SECRET: 'prod-refresh-secret-at-least-32-chars!',
      PHONEPE_REDIRECT_URL: 'https://admin.example.com/customer/payments/return',
      COOKIE_SECURE: 'false',
      BOOTSTRAP_DEMO: 'false',
      PHONEPE_ENABLED: 'false',
      PHONEPE_DEV_AUTO_SUCCESS: 'false',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('final production regression audit — staff login', () => {
  beforeAll(async () => {
    await startTestMongo();
  });

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('allows STAFF portal login', async () => {
    const password = 'StaffPass123!';
    await User.create([
      {
        name: 'Active Staff',
        phone: '+917199000001',
        passwordHash: await hashPassword(password),
        role: 'STAFF',
        status: 'ACTIVE',
      },
    ]);

    const issued = await login('+917199000001', password, { ip: '127.0.0.1' });
    expect(issued.data.user.role).toBe('STAFF');
    expect(issued.data.user.permissions).toEqual([]);
  }, 20_000);
});
