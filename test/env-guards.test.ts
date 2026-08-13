import { describe, expect, it } from 'vitest';
import { parseAppEnv } from '../src/config/env.js';

const baseEnv = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/kairali',
  WEB_ORIGINS: 'https://admin.example.com',
  JWT_ACCESS_SECRET: 'prod-access-secret-at-least-32-chars!!',
  JWT_REFRESH_SECRET: 'prod-refresh-secret-at-least-32-chars!',
  PHONEPE_REDIRECT_URL: 'https://admin.example.com/customer/payments/return',
  COOKIE_SECURE: 'true',
  BOOTSTRAP_DEMO: 'false',
  PHONEPE_ENABLED: 'false',
  PHONEPE_DEV_AUTO_SUCCESS: 'false',
} as const;

describe('production environment guards', () => {
  it('accepts a hardened production configuration', () => {
    const parsed = parseAppEnv(baseEnv);
    expect(parsed.success).toBe(true);
  });

  it('rejects BOOTSTRAP_DEMO in production', () => {
    const parsed = parseAppEnv({ ...baseEnv, BOOTSTRAP_DEMO: 'true' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('BOOTSTRAP_DEMO'))).toBe(true);
    }
  });

  it('rejects insecure cookies in production', () => {
    const parsed = parseAppEnv({ ...baseEnv, COOKIE_SECURE: 'false' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('COOKIE_SECURE'))).toBe(true);
    }
  });

  it('rejects sandbox PhonePe when enabled in production', () => {
    const parsed = parseAppEnv({
      ...baseEnv,
      PHONEPE_ENABLED: 'true',
      PHONEPE_ENV: 'SANDBOX',
      PHONEPE_CLIENT_ID: 'cid',
      PHONEPE_CLIENT_SECRET: 'csecret',
      PHONEPE_WEBHOOK_USERNAME: 'user',
      PHONEPE_WEBHOOK_PASSWORD: 'pass',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('PHONEPE_ENV'))).toBe(true);
    }
  });

  it('accepts production PhonePe when fully configured', () => {
    const parsed = parseAppEnv({
      ...baseEnv,
      PHONEPE_ENABLED: 'true',
      PHONEPE_ENV: 'PRODUCTION',
      PHONEPE_CLIENT_ID: 'cid',
      PHONEPE_CLIENT_SECRET: 'csecret',
      PHONEPE_WEBHOOK_USERNAME: 'user',
      PHONEPE_WEBHOOK_PASSWORD: 'pass',
    });
    expect(parsed.success).toBe(true);
  });
});
