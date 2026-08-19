import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  api,
  clearJestMongo,
  connectJestMongo,
  loginAsCustomer,
  seedCustomerPortalFixture,
} from './helpers/http.js';

describe('PhonePe client credentials API', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedCustomerPortalFixture();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects unauthenticated requests', async () => {
    await api().get('/api/v1/payments/phonepe/config').expect(401);
  });

  it('returns PhonePe SDK config for authenticated customers', async () => {
    const { cookies } = await loginAsCustomer();
    const response = await api()
      .get('/api/v1/payments/phonepe/config')
      .set('Cookie', cookies)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      enabled: expect.any(Boolean),
      environment: expect.stringMatching(/^(SANDBOX|PRODUCTION)$/),
      clientId: expect.any(String),
      clientSecret: expect.any(String),
      clientVersion: expect.any(Number),
      merchantId: expect.any(String),
      redirectUrl: expect.stringContaining('/customer/payments/return'),
    });
  });
});
