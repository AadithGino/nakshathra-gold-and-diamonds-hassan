import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  AuditLog,
  CashSubmission,
  Customer,
  Payment,
  PaymentCorrection,
  PaymentIntent,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import {
  requestCorrection,
  reviewCorrection,
  staffCashBalance,
  submitCash,
} from '../src/services/finance.service.js';
import {
  initiateStaffPhonePe,
  processPhonePeWebhook,
  reconcilePaymentIntentStatus,
} from '../src/services/gateway.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import {
  createEnrollment,
  createSchemePlan,
} from '../src/services/scheme-management.service.js';
import { createStaff } from '../src/services/staff.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import type { CreateStaffInput } from '../src/validators/staff.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917181500001';
const ADMIN2_PHONE = '+917181500091';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917181500002';
const OTHER_STAFF_PHONE = '+917181500003';
const VIEW_STAFF_PHONE = '+917181500004';
const STAFF_PASSWORD = 'StaffPass123!';
const CUSTOMER_PASSWORD = 'CustomerPass123!';
const MIN = 100_000;
const COLLECT_PERMISSIONS = ['canViewCustomers', 'canCollectPayment'] as const;
const CORRECT_PERMISSIONS = [
  'canViewCustomers',
  'canCollectPayment',
  'canSubmitCorrectionRequest',
] as const;

function cookieHeader(access: string) {
  return `access_token=${access}`;
}

function adminCtx(actorId: string, requestId: string) {
  return { actorId, actorRole: 'ADMIN' as const, requestId };
}

function staffCtx(actorId: string, requestId: string) {
  return { actorId, actorRole: 'STAFF' as const, requestId };
}

function monthStartIst(at = new Date()) {
  const local = toZonedTime(at, BUSINESS_TZ);
  const start = startOfMonth(local);
  start.setHours(0, 0, 0, 0);
  return fromZonedTime(start, BUSINESS_TZ);
}

function monthDate(start: Date, monthOffset: number, day = 10) {
  const local = toZonedTime(start, BUSINESS_TZ);
  const shifted = addMonths(startOfMonth(local), monthOffset);
  shifted.setDate(day);
  shifted.setHours(12, 0, 0, 0);
  return fromZonedTime(shifted, BUSINESS_TZ);
}

async function seedAdmin(phone = ADMIN_PHONE) {
  const [admin] = await User.create([
    {
      name: `Phase5 Admin ${phone.slice(-2)}`,
      phone,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedStaff(
  phone: string,
  permissions: CreateStaffInput['permissions'],
  employeeCode: string,
) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createStaff(
    {
      name: `Phase5 Staff ${employeeCode}`,
      phone,
      password: STAFF_PASSWORD,
      employeeCode,
      permissions,
    },
    adminCtx(actorId, `p5-staff-${employeeCode}`),
  );
}

async function seedVerifiedCustomer(opts: { name?: string; phone: string }) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    {
      name: opts.name ?? 'Phase5 Customer',
      phone: opts.phone,
      password: CUSTOMER_PASSWORD,
    },
    adminCtx(actorId, `p5-customer-${opts.phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Phase5 Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then settlement.',
    },
    adminCtx(actorId, 'p5-plan'),
  );
}

async function enrollCustomer(
  customerId: string,
  planId: string,
  startDate: Date,
  requestId: string,
) {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createEnrollment(
    {
      customerId,
      schemePlanId: planId,
      startDate,
      monthlyInstallmentPaise: MIN,
    },
    adminCtx(String(admin!._id), requestId),
  );
}

async function enablePhonePe() {
  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);
}

function mockPhonePeCheckout() {
  return vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => ({
    providerOrderId: `ORD-${input.merchantOrderId}`,
    state: 'PENDING',
    redirectUrl: 'https://phonepe.test/checkout',
    expiresAt: new Date(Date.now() + 600_000),
  }));
}

async function collectCash(
  staffUserId: string,
  customerId: string,
  schemeId: string,
  amountPaise: number,
  paymentDate: Date,
  key: string,
) {
  return createManualPayment(
    {
      customerId,
      schemeId,
      amountPaise,
      method: 'CASH',
      paymentDate,
      idempotencyKey: key,
    },
    staffCtx(staffUserId, key),
  );
}

describe('Phase 5 — staff PhonePe, cash handover and corrections', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('staff-assisted PhonePe', () => {
    it('denies staff without canCollectPayment from starting PhonePe', async () => {
      await seedAdmin();
      await seedStaff(VIEW_STAFF_PHONE, ['canViewCustomers'], 'NKS-S501');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500101' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-perm',
      );
      const issued = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

      const blocked = await request(app)
        .post('/api/v1/staff/payments/phonepe')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-denied-1',
        });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PERMISSION_DENIED');
      expect(await PaymentIntent.countDocuments()).toBe(0);
    });

    it('creates a staff PhonePe attempt owned by the customer and attributed to STAFF', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S502');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500102' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-create',
      );
      await enablePhonePe();
      mockPhonePeCheckout();
      const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

      const created = await request(app)
        .post('/api/v1/staff/payments/phonepe')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .set('Origin', 'http://localhost:5173')
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-create-1',
        })
        .expect(201);

      expect(created.body.data.status).toBe('PENDING');
      expect(created.body.data.checkoutUrl).toBeTruthy();
      const intent = await PaymentIntent.findOne({
        merchantTransactionId: created.body.data.merchantTransactionId,
      });
      expect(intent).toBeTruthy();
      expect(String(intent!.customerId)).toBe(String(customer._id));
      expect(String(intent!.schemeId)).toBe(String(enrollment._id));
      expect(String(intent!.collectedBy)).toBe(String(staff.userId));
      expect(intent!.collectorRole).toBe('STAFF');
      expect(intent!.idempotencyScope).toBe('PHONEPE_STAFF_WEB');
      expect(String(intent!.createdBy)).toBe(String(staff.userId));
    });

    it('rejects a staff PhonePe attempt when the enrollment is not owned by that customer', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S503');
      const plan = await seedCashPlan();
      const owner = await seedVerifiedCustomer({ phone: '+917181500103' });
      const other = await seedVerifiedCustomer({ phone: '+917181500104' });
      const enrollment = await enrollCustomer(
        String(owner._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-owner',
      );
      await enablePhonePe();

      await expect(
        initiateStaffPhonePe(
          String(staff.userId),
          {
            customerId: String(other._id),
            schemeId: String(enrollment._id),
            amountPaise: MIN,
            idempotencyKey: 'staff-pp-owner-1',
          },
          'p5-pp-owner',
          'http://localhost:5173',
        ),
      ).rejects.toMatchObject({ code: 'SCHEME_NOT_FOUND', statusCode: 404 });
    });

    it('finalizes a staff PhonePe webhook success onto the customer with STAFF collector attribution', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S504');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500105' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-wh',
      );
      await enablePhonePe();
      mockPhonePeCheckout();

      const launched = await initiateStaffPhonePe(
        String(staff.userId),
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-webhook-1',
        },
        'p5-pp-wh',
        'http://localhost:5173',
      );
      const intent = await PaymentIntent.findOne({
        merchantTransactionId: launched.merchantTransactionId,
      });
      vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
        kind: 'PAYMENT',
        event: 'checkout.order.completed',
        merchantOrderId: launched.merchantTransactionId,
        amountPaise: MIN,
        state: 'COMPLETED',
        raw: {},
      });
      vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
        state: 'SUCCESS',
        amountPaise: MIN,
        transactionId: 'PP-STAFF-1',
        raw: {},
      });

      const result = await processPhonePeWebhook(
        'auth',
        Buffer.from(JSON.stringify({ n: 'staff-success' })),
        'p5-pp-wh-cb',
      );
      expect(result).toMatchObject({ processed: true, state: 'SUCCESS' });
      expect((await PaymentIntent.findById(intent!._id))?.status).toBe('SUCCESS');

      const payment = await Payment.findOne({
        merchantTransactionId: launched.merchantTransactionId,
      });
      expect(payment).toBeTruthy();
      expect(payment!.status).toBe('SUCCESS');
      expect(String(payment!.customerId)).toBe(String(customer._id));
      expect(String(payment!.collectedBy)).toBe(String(staff.userId));
      expect(payment!.collectorRole).toBe('STAFF');
      expect(payment!.method).toBe('UPI');
    });

    it('does not capture a staff PhonePe attempt when the provider amount mismatches', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S505');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500106' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-mismatch',
      );
      await enablePhonePe();
      mockPhonePeCheckout();
      const launched = await initiateStaffPhonePe(
        String(staff.userId),
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-mismatch-1',
        },
        'p5-pp-mismatch',
        'http://localhost:5173',
      );
      const intent = await PaymentIntent.findOne({
        merchantTransactionId: launched.merchantTransactionId,
      });

      const result = await reconcilePaymentIntentStatus(
        String(intent!._id),
        'WEBHOOK',
        'p5-pp-mismatch-rec',
        { state: 'SUCCESS', amountPaise: MIN + 1, transactionId: 'PP-MISMATCH', raw: {} },
      );
      expect(result).toMatchObject({ amountMismatch: true });
      expect((await PaymentIntent.findById(intent!._id))?.status).toBe('PENDING');
      expect(await Payment.countDocuments()).toBe(0);
    });

    it('treats a duplicate staff PhonePe callback as a no-op after the first success', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S506');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500107' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-dup-cb',
      );
      await enablePhonePe();
      mockPhonePeCheckout();
      const launched = await initiateStaffPhonePe(
        String(staff.userId),
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-dup-cb-1',
        },
        'p5-pp-dup-cb',
        'http://localhost:5173',
      );
      const body = Buffer.from(JSON.stringify({ n: 'staff-dup' }));
      vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
        kind: 'PAYMENT',
        event: 'checkout.order.completed',
        merchantOrderId: launched.merchantTransactionId,
        amountPaise: MIN,
        state: 'COMPLETED',
        raw: {},
      });
      vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
        state: 'SUCCESS',
        amountPaise: MIN,
        transactionId: 'PP-STAFF-DUP',
        raw: {},
      });

      const first = await processPhonePeWebhook('auth', body, 'p5-pp-dup-1');
      const second = await processPhonePeWebhook('auth', body, 'p5-pp-dup-2');
      expect(first).toMatchObject({ processed: true, state: 'SUCCESS' });
      expect(second).toMatchObject({ duplicate: true });
      expect(
        await Payment.countDocuments({ merchantTransactionId: launched.merchantTransactionId }),
      ).toBe(1);
    });

    it('replays the same staff PhonePe idempotency key without creating a second attempt', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S507');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500108' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-idem',
      );
      await enablePhonePe();
      const create = mockPhonePeCheckout();
      const input = {
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        idempotencyKey: 'staff-pp-idem-1',
      };

      const first = await initiateStaffPhonePe(
        String(staff.userId),
        input,
        'p5-pp-idem-a',
        'http://localhost:5173',
      );
      const second = await initiateStaffPhonePe(
        String(staff.userId),
        input,
        'p5-pp-idem-b',
        'http://localhost:5173',
      );
      expect(second.merchantTransactionId).toBe(first.merchantTransactionId);
      expect(await PaymentIntent.countDocuments()).toBe(1);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('revalidates the capped-month remaining amount at staff PhonePe finalization', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S508');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500109' });
      const start = monthStartIst(addMonths(new Date(), -6));
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p5-pp-cap',
      );
      await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        monthDate(start, 0),
        'p5-pp-cap-m1',
      );
      await enablePhonePe();
      mockPhonePeCheckout();
      const launched = await initiateStaffPhonePe(
        String(staff.userId),
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-cap-1',
        },
        'p5-pp-cap',
        'http://localhost:5173',
      );
      await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-pp-cap-m7',
      );
      const intent = await PaymentIntent.findOne({
        merchantTransactionId: launched.merchantTransactionId,
      });

      const result = await reconcilePaymentIntentStatus(
        String(intent!._id),
        'WEBHOOK',
        'p5-pp-cap-rec',
        { state: 'SUCCESS', amountPaise: MIN, transactionId: 'PP-CAP', raw: {} },
      );
      expect(result.state).toBe('REVIEW_REQUIRED');
      expect((await PaymentIntent.findById(intent!._id))?.status).toBe('REVIEW_REQUIRED');
      expect(
        await Payment.countDocuments({
          schemeId: enrollment._id,
          schemeMonth: 7,
          status: 'SUCCESS',
        }),
      ).toBe(1);
    });

    it('blocks late staff PhonePe success after the enrollment is closed', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S509');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500110' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-pp-late',
      );
      await enablePhonePe();
      mockPhonePeCheckout();
      const launched = await initiateStaffPhonePe(
        String(staff.userId),
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'staff-pp-late-1',
        },
        'p5-pp-late',
        'http://localhost:5173',
      );
      await SchemeEnrollment.updateOne({ _id: enrollment._id }, { $set: { status: 'CLOSED' } });
      const intent = await PaymentIntent.findOne({
        merchantTransactionId: launched.merchantTransactionId,
      });

      const result = await reconcilePaymentIntentStatus(
        String(intent!._id),
        'WEBHOOK',
        'p5-pp-late-rec',
        { state: 'SUCCESS', amountPaise: MIN, transactionId: 'PP-LATE', raw: {} },
      );
      expect(result.state).toBe('REVIEW_REQUIRED');
      expect((await PaymentIntent.findById(intent!._id))?.status).toBe('REVIEW_REQUIRED');
      expect(await Payment.countDocuments({ status: 'SUCCESS' })).toBe(0);
    });
  });

  describe('cash accountability', () => {
    it('increases cash held for staff CASH collections and ignores digital collections', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S510');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500111' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-cash-inc',
      );
      const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

      await request(app)
        .post('/api/v1/staff/payments')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: new Date().toISOString(),
          idempotencyKey: 'p5-cash-held-cash',
        })
        .expect(201);
      expect(await staffCashBalance(String(staff.userId))).toBe(MIN);

      await request(app)
        .post('/api/v1/staff/payments')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'UPI',
          paymentDate: new Date().toISOString(),
          referenceNumber: 'UPI-HELD-1',
          idempotencyKey: 'p5-cash-held-upi',
        })
        .expect(201);
      expect(await staffCashBalance(String(staff.userId))).toBe(MIN);

      const held = await request(app)
        .get('/api/v1/staff/cash-held')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(held.body.data.cashHeldPaise).toBe(MIN);
    });

    it('lets admin record a handover that decreases held cash, including an exact full handover', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S511');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500112' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-cash-hand',
      );
      await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-cash-hand-1',
      );
      const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      const partial = await request(app)
        .post('/api/v1/admin/cash-submissions')
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .send({
          staffId: String(staff.userId),
          amountPaise: 40_000,
          submissionDate: new Date().toISOString(),
          notes: 'partial handover',
        })
        .expect(201);
      expect(partial.body.data.amountPaise).toBe(40_000);
      expect(await staffCashBalance(String(staff.userId))).toBe(60_000);

      await request(app)
        .post('/api/v1/admin/cash-submissions')
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .send({
          staffId: String(staff.userId),
          amountPaise: 60_000,
          submissionDate: new Date().toISOString(),
          notes: 'exact remainder',
        })
        .expect(201);
      expect(await staffCashBalance(String(staff.userId))).toBe(0);
    });

    it('accepts StaffProfile id as staffId on admin cash handover', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S511B');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500112' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-cash-profile-id',
      );
      await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-cash-profile-id-pay',
      );
      const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      await request(app)
        .post('/api/v1/admin/cash-submissions')
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .send({
          staffId: String(staff.profileId),
          amountPaise: MIN,
          submissionDate: new Date().toISOString(),
          notes: 'handover via profile id',
        })
        .expect(201);
      expect(await staffCashBalance(String(staff.userId))).toBe(0);
    });

    it('rejects an over-handover and keeps two concurrent handovers from exceeding held cash', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S512');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500113' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-cash-over',
      );
      await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-cash-over-1',
      );
      const admin = await User.findOne({ role: 'ADMIN' });

      await expect(
        submitCash(
          {
            staffId: String(staff.userId),
            amountPaise: MIN + 1,
            submissionDate: new Date(),
          },
          adminCtx(String(admin!._id), 'p5-over'),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_STAFF_CASH', statusCode: 409 });
      expect(await staffCashBalance(String(staff.userId))).toBe(MIN);

      const results = await Promise.allSettled([
        submitCash(
          {
            staffId: String(staff.userId),
            amountPaise: MIN,
            submissionDate: new Date(),
          },
          adminCtx(String(admin!._id), 'p5-race-a'),
        ),
        submitCash(
          {
            staffId: String(staff.userId),
            amountPaise: MIN,
            submissionDate: new Date(),
          },
          adminCtx(String(admin!._id), 'p5-race-b'),
        ),
      ]);
      const succeeded = results.filter((row) => row.status === 'fulfilled');
      const failed = results.filter((row) => row.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
      expect(['INSUFFICIENT_STAFF_CASH', 'STAFF_CASH_BUSY']).toContain(
        (failed[0] as PromiseRejectedResult).reason.code,
      );
      expect(await CashSubmission.countDocuments({ status: 'SUCCESS' })).toBe(1);
      expect(await staffCashBalance(String(staff.userId))).toBe(0);
    });

    it('reduces held cash when a staff CASH collection is reversed', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S513');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500114' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-cash-rev',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-cash-rev-1',
      );
      expect(await staffCashBalance(String(staff.userId))).toBe(MIN);

      const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
      await request(app)
        .post(`/api/v1/admin/payments/${payment.paymentId}/reverse`)
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .send({ reason: 'cash collected in error' })
        .expect(200);
      expect(await staffCashBalance(String(staff.userId))).toBe(0);
    });

    it('lets staff view only their own cash held/history while admin can view all', async () => {
      await seedAdmin();
      const staffA = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S514');
      const staffB = await seedStaff(OTHER_STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S515');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500115' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-cash-scope',
      );
      await collectCash(
        String(staffA.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-cash-scope-a',
      );
      const admin = await User.findOne({ role: 'ADMIN' });
      await submitCash(
        {
          staffId: String(staffA.userId),
          amountPaise: 25_000,
          submissionDate: new Date(),
          notes: 'A handover',
        },
        adminCtx(String(admin!._id), 'p5-cash-scope-h'),
      );

      const issuedA = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
      const issuedB = await login(OTHER_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
      const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      const heldA = await request(app)
        .get('/api/v1/staff/cash-held')
        .set('Cookie', cookieHeader(issuedA.tokens.access))
        .expect(200);
      const heldB = await request(app)
        .get('/api/v1/staff/cash-held')
        .set('Cookie', cookieHeader(issuedB.tokens.access))
        .expect(200);
      expect(heldA.body.data.cashHeldPaise).toBe(75_000);
      expect(heldB.body.data.cashHeldPaise).toBe(0);

      const ownHistory = await request(app)
        .get('/api/v1/staff/cash-submissions')
        .set('Cookie', cookieHeader(issuedA.tokens.access))
        .expect(200);
      const otherHistory = await request(app)
        .get('/api/v1/staff/cash-submissions')
        .set('Cookie', cookieHeader(issuedB.tokens.access))
        .expect(200);
      expect(ownHistory.body.data).toHaveLength(1);
      expect(otherHistory.body.data).toHaveLength(0);

      const adminHeld = await request(app)
        .get('/api/v1/admin/cash-held')
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .expect(200);
      const byStaff = new Map(
        adminHeld.body.data.map((row: { staffId: string; cashHeldPaise: number }) => [
          row.staffId,
          row.cashHeldPaise,
        ]),
      );
      expect(byStaff.get(String(staffA.userId))).toBe(75_000);
      expect(byStaff.get(String(staffB.userId))).toBe(0);

      const adminHistory = await request(app)
        .get('/api/v1/admin/cash-submissions')
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .expect(200);
      expect(adminHistory.body.data.length).toBeGreaterThanOrEqual(1);

      const staffAdminBlocked = await request(app)
        .get('/api/v1/admin/cash-held')
        .set('Cookie', cookieHeader(issuedA.tokens.access));
      expect(staffAdminBlocked.status).toBe(403);
    });
  });

  describe('correction requests', () => {
    it('blocks staff from directly editing a posted payment', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S516');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500116' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-corr-edit',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-corr-edit-1',
      );
      const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

      const patched = await request(app)
        .patch(`/api/v1/staff/payments/${payment.paymentId}`)
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({ amountPaise: MIN + 1 });
      expect(patched.status).toBe(404);
      expect((await Payment.findById(payment.paymentId))?.amountPaise).toBe(MIN);
    });

    it('lets authorized staff create a correction and denies unauthorized staff', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S517');
      await seedStaff(VIEW_STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S518');
      const other = await seedStaff(OTHER_STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S519');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500117' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-corr-create',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-corr-create-1',
      );
      const allowed = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
      const noPerm = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
      const otherStaff = await login(OTHER_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

      const created = await request(app)
        .post(`/api/v1/staff/payments/${payment.paymentId}/corrections`)
        .set('Cookie', cookieHeader(allowed.tokens.access))
        .send({
          correctionType: 'CHANGE_NOTES',
          requestedChanges: { notes: 'counter note' },
          reason: 'customer asked to update notes',
        })
        .expect(201);
      expect(created.body.data.status).toBe('PENDING');
      expect(created.body.data.correctionType).toBe('CHANGE_NOTES');

      const deniedPerm = await request(app)
        .post(`/api/v1/staff/payments/${payment.paymentId}/corrections`)
        .set('Cookie', cookieHeader(noPerm.tokens.access))
        .send({
          correctionType: 'CHANGE_NOTES',
          requestedChanges: { notes: 'nope' },
          reason: 'should not be allowed to request',
        });
      expect(deniedPerm.status).toBe(403);

      const deniedOwner = await request(app)
        .post(`/api/v1/staff/payments/${payment.paymentId}/corrections`)
        .set('Cookie', cookieHeader(otherStaff.tokens.access))
        .send({
          correctionType: 'CHANGE_NOTES',
          requestedChanges: { notes: 'other staff' },
          reason: 'not the collecting staff member',
        });
      expect(deniedOwner.status).toBe(404);
      expect(other.userId).toBeTruthy();
    });

    it('lets admin reject a pending correction without changing the payment', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S520');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500118' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-corr-rej',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-corr-rej-1',
      );
      const correction = await requestCorrection(
        String(payment.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN + 50_000 },
          reason: 'typed the wrong amount',
        },
        staffCtx(String(staff.userId), 'p5-corr-rej-req'),
      );
      const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      const rejected = await request(app)
        .patch(`/api/v1/admin/corrections/${correction._id}`)
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .send({ decision: 'REJECTED', reviewNotes: 'original amount is correct' })
        .expect(200);
      expect(rejected.body.data.status).toBe('REJECTED');
      expect((await Payment.findById(payment.paymentId))?.status).toBe('SUCCESS');
      expect((await Payment.findById(payment.paymentId))?.amountPaise).toBe(MIN);
    });

    it('approves a financial correction once, reversing the original and linking a single replacement', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S521');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500119' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-corr-ok',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-corr-ok-1',
      );
      const admin = await User.findOne({ role: 'ADMIN' });
      const correction = await requestCorrection(
        String(payment.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN + 25_000 },
          reason: 'customer paid extra cash',
        },
        staffCtx(String(staff.userId), 'p5-corr-ok-req'),
      );

      await expect(
        reviewCorrection(String(correction._id), 'APPROVED', 'self review', {
          actorId: String(staff.userId),
          requestId: 'p5-corr-self',
        }),
      ).rejects.toMatchObject({ code: 'CORRECTION_SELF_REVIEW_FORBIDDEN', statusCode: 403 });

      const first = await reviewCorrection(String(correction._id), 'APPROVED', 'apply extra cash', {
        actorId: String(admin!._id),
        requestId: 'p5-corr-ok-1',
      });
      const second = await reviewCorrection(String(correction._id), 'APPROVED', 'apply extra cash', {
        actorId: String(admin!._id),
        requestId: 'p5-corr-ok-2',
      });

      expect(first.replacement?._id).toBeTruthy();
      expect(String(second.replacement?._id)).toBe(String(first.replacement?._id));
      expect((await Payment.findById(payment.paymentId))?.status).toBe('REVERSED');
      expect(first.replacement?.amountPaise).toBe(MIN + 25_000);
      expect(first.replacement?.status).toBe('SUCCESS');
      expect(String(first.replacement?.supersedesPaymentId)).toBe(String(payment.paymentId));
      expect(String(first.replacement?.correctionId)).toBe(String(correction._id));
      expect(String((await PaymentCorrection.findById(correction._id))?.replacementPaymentId)).toBe(
        String(first.replacement?._id),
      );
      expect(
        await Payment.countDocuments({
          schemeId: enrollment._id,
          status: 'SUCCESS',
        }),
      ).toBe(1);

      const requested = await AuditLog.find({ action: 'CORRECTION_REQUESTED' });
      const approved = await AuditLog.find({ action: 'CORRECTION_APPROVED' });
      expect(requested).toHaveLength(1);
      expect(approved).toHaveLength(1);
    });

    it('rejects a corrected amount that would violate the capped-month remaining cap', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S522');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500120' });
      const start = monthStartIst(addMonths(new Date(), -6));
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p5-corr-cap',
      );
      await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        monthDate(start, 0),
        'p5-corr-cap-m1',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-corr-cap-m7',
      );
      const admin = await User.findOne({ role: 'ADMIN' });
      const correction = await requestCorrection(
        String(payment.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN + 50_000 },
          reason: 'cannot exceed month-7 cap',
        },
        staffCtx(String(staff.userId), 'p5-corr-cap-req'),
      );

      await expect(
        reviewCorrection(String(correction._id), 'APPROVED', 'over cap', {
          actorId: String(admin!._id),
          requestId: 'p5-corr-cap-app',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_LIMIT_EXCEEDED', statusCode: 409 });
      expect((await Payment.findById(payment.paymentId))?.status).toBe('SUCCESS');
      expect((await PaymentCorrection.findById(correction._id))?.status).toBe('PENDING');
      expect(await Payment.countDocuments({ status: 'SUCCESS', schemeMonth: 7 })).toBe(1);
    });

    it('makes concurrent approvals safe so only one replacement is created', async () => {
      await seedAdmin();
      const admin2 = await seedAdmin(ADMIN2_PHONE);
      const staff = await seedStaff(STAFF_PHONE, [...CORRECT_PERMISSIONS], 'NKS-S523');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917181500121' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p5-corr-race',
      );
      const payment = await collectCash(
        String(staff.userId),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'p5-corr-race-1',
      );
      const admin = await User.findOne({ phone: ADMIN_PHONE });
      const correction = await requestCorrection(
        String(payment.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN + 10_000 },
          reason: 'concurrent approval must not double apply',
        },
        staffCtx(String(staff.userId), 'p5-corr-race-req'),
      );

      const results = await Promise.allSettled([
        reviewCorrection(String(correction._id), 'APPROVED', 'admin one', {
          actorId: String(admin!._id),
          requestId: 'p5-corr-race-a',
        }),
        reviewCorrection(String(correction._id), 'APPROVED', 'admin two', {
          actorId: String(admin2._id),
          requestId: 'p5-corr-race-b',
        }),
      ]);
      const succeeded = results.filter((row) => row.status === 'fulfilled');
      const failed = results.filter((row) => row.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CORRECTION_ALREADY_REVIEWED',
        statusCode: 409,
      });
      expect((await Payment.findById(payment.paymentId))?.status).toBe('REVERSED');
      expect(
        await Payment.countDocuments({
          schemeId: enrollment._id,
          status: 'SUCCESS',
        }),
      ).toBe(1);
      expect(
        await Payment.countDocuments({
          supersedesPaymentId: payment.paymentId,
        }),
      ).toBe(1);
    });
  });
});
