import { createServer, type Server } from 'node:http';
import mongoose from 'mongoose';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { app } from '../../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../../src/config/database.js';
import {
  Customer,
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../../../src/models/index.js';
import { hashPassword } from '../../../src/services/auth.service.js';
import { enrollmentDates } from '../../../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../../../src/utils/time.js';

export const INSTALLMENT_PAISE = 100_000;
export const CUSTOMER_PHONE = '+919876543210';
export const CUSTOMER_PASSWORD = 'TestPass123!';
export const ADMIN_PHONE = '+919876543299';
export const ADMIN_PASSWORD = 'AdminPass123!';

let jestServer: Server | undefined;
let mongoConnected = false;
let connectLock: Promise<void> | null = null;

async function listenJestServer() {
  if (jestServer?.listening) return;
  await new Promise<void>((resolve, reject) => {
    const server = createServer(app);
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      jestServer = server;
      resolve();
    });
  });
}

export async function connectJestMongo() {
  if (!connectLock) {
    connectLock = (async () => {
      await connectDatabase();
      mongoConnected = true;
      await listenJestServer();
    })().finally(() => {
      connectLock = null;
    });
  }
  await connectLock;
}

export async function stopJestHttp() {
  const server = jestServer;
  jestServer = undefined;
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (mongoConnected) {
    await disconnectDatabase();
    mongoConnected = false;
  }
}

export async function clearJestMongo() {
  if (mongoose.connection.readyState !== 1) {
    await connectDatabase();
    mongoConnected = true;
  }
  const collections = mongoose.connection.collections;
  for (const collection of Object.values(collections)) {
    await collection.deleteMany({});
  }
}

export function api() {
  if (!jestServer?.listening) {
    throw new Error('api() called before connectJestMongo() finished');
  }
  return request(jestServer);
}

export async function seedCustomerPortalFixture() {
  const passwordHash = await hashPassword(CUSTOMER_PASSWORD);
  const [user] = await User.create([
    {
      name: 'Jest Customer',
      phone: CUSTOMER_PHONE,
      passwordHash,
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);

  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: 'CUST-JEST-001',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: user._id,
    },
  ]);

  const now = new Date();
  const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);

  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: user._id,
      enrollmentNumber: 'ENR-JEST-001',
      schemeType: 'GOLD_WEIGHT',
      startDate,
      flexiblePeriodEndDate: dates.flexiblePeriodEndDate,
      maturityDate: dates.maturityDate,
      redemptionStartDate: dates.redemptionStartDate,
      redemptionEndDate: dates.redemptionEndDate,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT_PAISE,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: user._id,
    },
  ]);

  const { start: todayStart } = businessDayRange(now);
  await GoldRate.create([
    {
      ratePerGramPaise: 750_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: user._id,
    },
  ]);

  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);

  return { user, customer, enrollment };
}

export async function loginAsCustomer() {
  const response = await api()
    .post('/api/v1/auth/login')
    .send({ phone: CUSTOMER_PHONE, password: CUSTOMER_PASSWORD })
    .expect(200);
  const cookies = response.headers['set-cookie'];
  if (!cookies) throw new Error('login did not set cookies');
  const cookieHeader = Array.isArray(cookies)
    ? cookies.map((c) => c.split(';')[0]).join('; ')
    : String(cookies).split(';')[0];
  return { cookies: cookieHeader, body: response.body };
}

export async function seedAdminGatewayPaymentFixture() {
  const adminHash = await hashPassword(ADMIN_PASSWORD);
  const customerHash = await hashPassword(CUSTOMER_PASSWORD);
  const [admin] = await User.create([
    {
      name: 'Jest Admin',
      phone: ADMIN_PHONE,
      passwordHash: adminHash,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [customerUser] = await User.create([
    {
      name: 'Jest Customer',
      phone: CUSTOMER_PHONE,
      passwordHash: customerHash,
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: 'CUST-JEST-RFD',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: admin._id,
    },
  ]);

  const now = new Date();
  const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: admin._id,
      enrollmentNumber: 'ENR-JEST-RFD',
      schemeType: 'GOLD_WEIGHT',
      startDate,
      flexiblePeriodEndDate: dates.flexiblePeriodEndDate,
      maturityDate: dates.maturityDate,
      redemptionStartDate: dates.redemptionStartDate,
      redemptionEndDate: dates.redemptionEndDate,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT_PAISE,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: admin._id,
    },
  ]);

  const { start: todayStart } = businessDayRange(now);
  await GoldRate.create([
    {
      ratePerGramPaise: 750_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: admin._id,
    },
  ]);
  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);

  const merchantTransactionId = `KRL-JEST-RFD-${Date.now()}`;
  await PaymentIntent.create([
    {
      customerId: customer._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT_PAISE,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'SUCCESS',
      idempotencyKey: `jest-rfd-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'jest-refund-hash',
      goldRatePerGramPaise: 700_000,
      goldWeightMg: 142,
      goldPurity: '916',
      schemeMonth: 1,
      collectorRole: 'CUSTOMER',
      createdBy: customerUser._id,
    },
  ]);
  const [payment] = await Payment.create([
    {
      customerId: customer._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT_PAISE,
      method: 'UPI',
      status: 'SUCCESS',
      paymentDate: now,
      schemeMonth: 1,
      receiptNumber: `KRL-2026-${String(Date.now()).slice(-7)}`,
      merchantTransactionId,
      providerTransactionId: `PP-${merchantTransactionId}`,
      goldRatePerGramPaise: 700_000,
      goldWeightMg: 142,
      goldPurity: '916',
      collectorRole: 'CUSTOMER',
      createdBy: customerUser._id,
      recognizedAt: now,
      accountingDate: now,
    },
  ]);

  return { admin, customer, enrollment, payment, merchantTransactionId };
}

export async function loginAsAdmin() {
  const response = await api()
    .post('/api/v1/auth/login')
    .send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    .expect(200);
  const cookies = response.headers['set-cookie'];
  if (!cookies) throw new Error('admin login did not set cookies');
  const cookieHeader = Array.isArray(cookies)
    ? cookies.map((c) => c.split(';')[0]).join('; ')
    : String(cookies).split(';')[0];
  return { cookies: cookieHeader, body: response.body };
}
