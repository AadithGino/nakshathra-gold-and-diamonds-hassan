import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Customer,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  SchemePlan,
  User,
} from '../src/models/index.js';
import { NAKSHATHRA_CAP_STRATEGY } from '../src/config/business.js';
import { createManualPayment, finalizeGatewayPayment } from '../src/services/payment.service.js';
import {
  createSchemePlan,
  createEnrollmentRecord,
} from '../src/services/scheme-management.service.js';
import { executeSchemeSettlement } from '../src/services/scheme-settlement.service.js';
import {
  averageMonthlyCapPaise,
  enrollmentDates,
  getPaymentRules,
  previewContributionPayment,
  resolvePaymentPhase,
} from '../src/services/scheme.service.js';
import {
  averageSuccessfulPaymentCapPaise,
  contributionSchemeMonth,
  usesNakshathraContributionPolicy,
} from '../src/utils/contribution-policy.js';
import { AppError } from '../src/utils/AppError.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { withMongoTransaction } from '../src/utils/transaction.js';
import {
  MIGRATION_ACK_VALUE,
  runNakshathraSchemeEngineApply,
  runNakshathraSchemeEngineVerify,
} from '../src/scripts/migrations/2026-08-nakshathra-scheme-engine.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const MIN = 100_000;

function ist(isoLocal: string) {
  return new Date(isoLocal);
}

function monthDate(start: Date, monthOffset: number, day = 10) {
  const local = toZonedTime(start, BUSINESS_TZ);
  const shifted = addMonths(startOfMonth(local), monthOffset);
  shifted.setDate(day);
  shifted.setHours(12, 0, 0, 0);
  return fromZonedTime(shifted, BUSINESS_TZ);
}

async function seedActor() {
  const [admin] = await User.create([
    {
      name: 'Phase2 Admin',
      phone: `+9177${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [user] = await User.create([
    {
      name: 'Phase2 Customer',
      phone: `+9178${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: `NKS-C${String(Date.now()).slice(-6)}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: admin._id,
    },
  ]);
  return { admin, user, customer };
}

async function seedNakshathraEnrollment(start = ist('2026-01-01T00:00:00+05:30')) {
  const { admin, user, customer } = await seedActor();
  const dates = enrollmentDates(start, 6, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: admin._id,
      enrollmentNumber: `NKS-ENR-P2-${Date.now()}`,
      schemeType: 'CASH',
      startDate: start,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 6,
      capMonths: 5,
      capStrategy: NAKSHATHRA_CAP_STRATEGY,
      contributionPolicyVersion: 1,
      monthlyInstallmentPaise: MIN,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: admin._id,
    },
  ]);
  return { admin, user, customer, enrollment, start };
}

async function pay(opts: {
  admin: { _id: unknown };
  customer: { _id: unknown };
  enrollment: { _id: unknown };
  amountPaise: number;
  paymentDate: Date;
  key: string;
  schemeMonth?: number;
}) {
  return createManualPayment(
    {
      customerId: String(opts.customer._id),
      schemeId: String(opts.enrollment._id),
      amountPaise: opts.amountPaise,
      schemeMonth: opts.schemeMonth,
      method: 'CASH',
      paymentDate: opts.paymentDate,
      idempotencyKey: opts.key,
    },
    {
      actorId: String(opts.admin._id),
      actorRole: 'ADMIN',
      requestId: opts.key,
    },
  );
}

describe('Phase 2 — Nakshathra 6+5 scheme engine', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  describe('scheme month', () => {
    const start = ist('2026-01-01T00:00:00+05:30');

    it('treats the exact start boundary as month 1', () => {
      expect(contributionSchemeMonth(start, ist('2026-01-01T00:00:00+05:30'))).toBe(1);
    });

    it('keeps end-of-month inside the same calendar month', () => {
      expect(contributionSchemeMonth(start, ist('2026-01-31T23:59:59.999+05:30'))).toBe(1);
    });

    it('crosses at IST midnight', () => {
      expect(contributionSchemeMonth(start, ist('2026-01-31T23:59:59.999+05:30'))).toBe(1);
      expect(contributionSchemeMonth(start, ist('2026-02-01T00:00:00+05:30'))).toBe(2);
    });

    it('resolves month 1, month 6, the 6→7 transition, and month 11', () => {
      expect(contributionSchemeMonth(start, ist('2026-01-15T12:00:00+05:30'))).toBe(1);
      expect(contributionSchemeMonth(start, ist('2026-06-30T23:59:59.999+05:30'))).toBe(6);
      expect(contributionSchemeMonth(start, ist('2026-07-01T00:00:00+05:30'))).toBe(7);
      expect(contributionSchemeMonth(start, ist('2026-11-30T23:59:59.999+05:30'))).toBe(11);
    });

    it('rejects dates after the contribution period', () => {
      expect(() => contributionSchemeMonth(start, ist('2026-12-01T00:00:00+05:30'))).toThrow(
        AppError,
      );
      try {
        contributionSchemeMonth(start, ist('2026-12-01T00:00:00+05:30'));
      } catch (error) {
        expect(error).toMatchObject({ code: 'SCHEME_MATURED' });
      }
    });

    it('rejects dates before enrollment start', () => {
      try {
        contributionSchemeMonth(start, ist('2025-12-31T23:59:59.999+05:30'));
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toMatchObject({ code: 'SCHEME_NOT_STARTED' });
      }
    });
  });

  describe('live plan snapshot', () => {
    it('creates CASH plans as 6+5 with AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6', async () => {
      const { admin, customer } = await seedActor();
      const plan = await createSchemePlan(
        {
          name: 'Nakshathra Cash Live',
          type: 'CASH',
          durationMonths: 11,
          minimumPaymentPaise: MIN,
          termsText: 'Six flexible months then five capped months.',
        },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p2-plan' },
      );
      expect(plan.flexibleMonths).toBe(6);
      expect(plan.capMonths).toBe(5);
      expect(plan.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
      expect(plan.type).toBe('CASH');

      const enrollment = await withMongoTransaction(async (session) =>
        createEnrollmentRecord(
          {
            customerId: String(customer._id),
            schemePlanId: String(plan._id),
            startDate: ist('2026-01-01T00:00:00+05:30'),
            monthlyInstallmentPaise: MIN,
          },
          { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p2-enroll' },
          session,
        ),
      );
      expect(enrollment.flexibleMonths).toBe(6);
      expect(enrollment.capMonths).toBe(5);
      expect(enrollment.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
      expect(enrollment.planSnapshot?.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
      expect(usesNakshathraContributionPolicy(enrollment)).toBe(true);
    });
  });

  describe('flexible months', () => {
    it('allows multiple different amounts in the same month with no cap', async () => {
      const fixture = await seedNakshathraEnrollment();
      const date = monthDate(fixture.start, 0);
      await pay({ ...fixture, amountPaise: 100_000, paymentDate: date, key: 'flex-a' });
      await pay({ ...fixture, amountPaise: 250_000, paymentDate: date, key: 'flex-b' });
      await pay({ ...fixture, amountPaise: 175_000, paymentDate: date, key: 'flex-c' });
      const rules = await getPaymentRules(String(fixture.enrollment._id), date, 100_000);
      expect(rules.phase).toBe('FLEXIBLE');
      expect(rules.capApplies).toBe(false);
      expect(rules.capPaise).toBeNull();
      expect(rules.paidThisMonthPaise).toBe(525_000);
      expect(await Payment.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
        3,
      );
    });

    it('still enforces the minimum payment', async () => {
      const fixture = await seedNakshathraEnrollment();
      await expect(
        pay({
          ...fixture,
          amountPaise: 99_999,
          paymentDate: monthDate(fixture.start, 0),
          key: 'flex-min',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_BELOW_MINIMUM' });
    });
  });

  describe('cap formula', () => {
    it('uses amount/count, not total/6', () => {
      expect(averageSuccessfulPaymentCapPaise(450_000, 3)).toBe(150_000);
      expect(averageMonthlyCapPaise(450_000, 6)).toBe(75_000);
      expect(averageSuccessfulPaymentCapPaise(450_000, 3)).not.toBe(
        averageMonthlyCapPaise(450_000, 6),
      );
    });

    it('floors leftover paise', () => {
      expect(averageSuccessfulPaymentCapPaise(100_001, 2)).toBe(50_000);
    });

    it('rejects a zero payment count without dividing', () => {
      expect(() => averageSuccessfulPaymentCapPaise(0, 0)).toThrow(AppError);
      try {
        averageSuccessfulPaymentCapPaise(0, 0);
      } catch (error) {
        expect(error).toMatchObject({ code: 'FIRST_PERIOD_EMPTY' });
      }
    });

    it('excludes failed, reversed, and pending rows from the cap', async () => {
      const fixture = await seedNakshathraEnrollment();
      const month1 = monthDate(fixture.start, 0);
      await Payment.create([
        {
          customerId: fixture.customer._id,
          schemeId: fixture.enrollment._id,
          amountPaise: 100_000,
          method: 'CASH',
          status: 'SUCCESS',
          paymentDate: month1,
          schemeMonth: 1,
          collectorRole: 'ADMIN',
          createdBy: fixture.admin._id,
        },
        {
          customerId: fixture.customer._id,
          schemeId: fixture.enrollment._id,
          amountPaise: 900_000,
          method: 'CASH',
          status: 'FAILED',
          paymentDate: month1,
          schemeMonth: 1,
          collectorRole: 'ADMIN',
          createdBy: fixture.admin._id,
        },
        {
          customerId: fixture.customer._id,
          schemeId: fixture.enrollment._id,
          amountPaise: 800_000,
          method: 'CASH',
          status: 'REVERSED',
          paymentDate: month1,
          schemeMonth: 1,
          reversedAt: new Date(),
          collectorRole: 'ADMIN',
          createdBy: fixture.admin._id,
        },
        {
          customerId: fixture.customer._id,
          schemeId: fixture.enrollment._id,
          amountPaise: 700_000,
          method: 'UPI',
          status: 'PENDING',
          paymentDate: month1,
          schemeMonth: 1,
          collectorRole: 'CUSTOMER',
          createdBy: fixture.admin._id,
        },
      ]);
      const month7 = monthDate(fixture.start, 6);
      const rules = await getPaymentRules(String(fixture.enrollment._id), month7, 100_000, undefined, {
        enforceLimit: false,
      });
      expect(rules.phase).toBe('CAPPED');
      expect(rules.capPaise).toBe(100_000);
    });
  });

  describe('capped months', () => {
    async function seedWithFirstPeriod(amounts: number[]) {
      const fixture = await seedNakshathraEnrollment();
      for (const [index, amountPaise] of amounts.entries()) {
        await pay({
          ...fixture,
          amountPaise,
          paymentDate: monthDate(fixture.start, index % 6, 5 + index),
          key: `first-${index}-${amountPaise}`,
        });
      }
      return fixture;
    }

    it('allows below-cap and exact-cap payments and rejects +1 paise', async () => {
      const below = await seedWithFirstPeriod([200_000]);
      await pay({
        ...below,
        amountPaise: 100_000,
        paymentDate: monthDate(below.start, 6),
        key: 'cap-below',
      });

      const exact = await seedWithFirstPeriod([150_000]);
      await pay({
        ...exact,
        amountPaise: 150_000,
        paymentDate: monthDate(exact.start, 6),
        key: 'cap-exact-ok',
      });

      const over = await seedWithFirstPeriod([100_000]);
      await expect(
        pay({
          ...over,
          amountPaise: 100_001,
          paymentDate: monthDate(over.start, 6),
          key: 'cap-plus-one',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_LIMIT_EXCEEDED' });
    });

    it('accumulates multiple payments up to the cap', async () => {
      const fixture = await seedWithFirstPeriod([200_000]);
      const month7 = monthDate(fixture.start, 6);
      await pay({ ...fixture, amountPaise: 100_000, paymentDate: month7, key: 'acc-1' });
      await pay({ ...fixture, amountPaise: 100_000, paymentDate: month7, key: 'acc-2' });
      await expect(
        pay({ ...fixture, amountPaise: 100_000, paymentDate: month7, key: 'acc-3' }),
      ).rejects.toMatchObject({ code: 'PAYMENT_LIMIT_EXCEEDED' });
    });

    it('starts a fresh usage bucket in the next capped month', async () => {
      const fixture = await seedWithFirstPeriod([200_000]);
      await pay({
        ...fixture,
        amountPaise: 200_000,
        paymentDate: monthDate(fixture.start, 6),
        key: 'm7-full',
      });
      await pay({
        ...fixture,
        amountPaise: 200_000,
        paymentDate: monthDate(fixture.start, 7),
        key: 'm8-own',
      });
      expect(
        await Payment.countDocuments({
          schemeId: fixture.enrollment._id,
          status: 'SUCCESS',
          schemeMonth: 8,
        }),
      ).toBe(1);
    });

    it('is not payable when the first six months have no SUCCESS payments', async () => {
      const fixture = await seedNakshathraEnrollment();
      await expect(
        pay({
          ...fixture,
          amountPaise: 100_000,
          paymentDate: monthDate(fixture.start, 6),
          key: 'empty-first',
        }),
      ).rejects.toMatchObject({ code: 'FIRST_PERIOD_EMPTY' });
      const preview = await previewContributionPayment(
        String(fixture.enrollment._id),
        100_000,
        monthDate(fixture.start, 6),
      );
      expect(preview.allowed).toBe(false);
      expect(preview.phase).toBe('CAPPED');
      expect(preview.reasonCode).toBe('FIRST_PERIOD_EMPTY');
    });
  });

  describe('preview', () => {
    it('returns informational 6+5 fields and is not the posting authority', async () => {
      const fixture = await seedNakshathraEnrollment();
      const preview = await previewContributionPayment(
        String(fixture.enrollment._id),
        100_000,
        monthDate(fixture.start, 0),
      );
      expect(preview).toMatchObject({
        enrollmentId: String(fixture.enrollment._id),
        schemeMonth: 1,
        phase: 'FLEXIBLE',
        allowed: true,
        minimumPaymentPaise: MIN,
        monthlyCapPaise: null,
        capApplies: false,
        capStrategy: NAKSHATHRA_CAP_STRATEGY,
      });
    });
  });

  describe('CASH path', () => {
    it('does not snapshot gold on a CASH contribution', async () => {
      const fixture = await seedNakshathraEnrollment();
      await pay({
        ...fixture,
        amountPaise: 100_000,
        paymentDate: monthDate(fixture.start, 0),
        key: 'cash-no-gold',
      });
      const payment = await Payment.findOne({ schemeId: fixture.enrollment._id });
      expect(payment?.goldRateId).toBeUndefined();
      expect(payment?.goldWeightMg).toBeUndefined();
      expect(payment?.goldRatePerGramPaise).toBeUndefined();
    });
  });

  describe('concurrency', () => {
    it('does not let two different keys jointly exceed the cap', async () => {
      const fixture = await seedNakshathraEnrollment();
      await pay({
        ...fixture,
        amountPaise: 100_000,
        paymentDate: monthDate(fixture.start, 0),
        key: 'conc-first',
      });
      const month7 = monthDate(fixture.start, 6);
      const settled = await Promise.allSettled([
        pay({ ...fixture, amountPaise: 100_000, paymentDate: month7, key: 'conc-a' }),
        pay({ ...fixture, amountPaise: 100_000, paymentDate: month7, key: 'conc-b' }),
      ]);
      const ok = settled.filter((row) => row.status === 'fulfilled');
      const failed = settled.filter((row) => row.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'PAYMENT_LIMIT_EXCEEDED',
      });
      const total = await Payment.aggregate([
        {
          $match: {
            schemeId: fixture.enrollment._id,
            status: 'SUCCESS',
            schemeMonth: 7,
          },
        },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]);
      expect(total[0]?.total).toBe(100_000);
    });

    it('returns the same payment for a duplicate idempotency key', async () => {
      const fixture = await seedNakshathraEnrollment();
      const date = monthDate(fixture.start, 0);
      const first = await pay({
        ...fixture,
        amountPaise: 120_000,
        paymentDate: date,
        key: 'dup-key-0001',
      });
      const second = await pay({
        ...fixture,
        amountPaise: 120_000,
        paymentDate: date,
        key: 'dup-key-0001',
      });
      expect(String(second.paymentId)).toBe(String(first.paymentId));
      expect(await Payment.countDocuments({ schemeId: fixture.enrollment._id })).toBe(1);
    });

    it('blocks a payment that races a closure', async () => {
      const fixture = await seedNakshathraEnrollment();
      await pay({
        ...fixture,
        amountPaise: 100_000,
        paymentDate: monthDate(fixture.start, 0),
        key: 'close-seed',
      });
      const month2 = monthDate(fixture.start, 1);
      const results = await Promise.allSettled([
        pay({
          ...fixture,
          amountPaise: 100_000,
          paymentDate: month2,
          key: 'race-pay',
        }),
        executeSchemeSettlement(
          {
            enrollmentId: String(fixture.enrollment._id),
            kind: 'PREMATURE_CLOSE',
            settlementAsset: 'CASH',
            payoutDate: month2,
            reason: 'Close during payment race',
            idempotencyKey: 'race-close-0001',
          },
          {
            actorId: String(fixture.admin._id),
            actorRole: 'ADMIN',
            requestId: 'race-close',
          },
        ),
      ]);
      const payResult = results[0];
      const closeResult = results[1];
      const payFailed =
        payResult.status === 'rejected' &&
        ['SCHEME_SETTLEMENT_IN_PROGRESS', 'SCHEME_NOT_ACTIVE', 'SCHEME_ALREADY_SETTLED'].includes(
          (payResult.reason as AppError)?.code,
        );
      const closeFailed =
        closeResult.status === 'rejected' &&
        ['SCHEME_SETTLEMENT_IN_PROGRESS', 'SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT'].includes(
          (closeResult.reason as AppError)?.code,
        );
      expect(payFailed || closeFailed || payResult.status === 'fulfilled').toBe(true);
      const enrollment = await SchemeEnrollment.findById(fixture.enrollment._id);
      if (enrollment?.status === 'CLOSED') {
        const extra = await Payment.countDocuments({
          schemeId: fixture.enrollment._id,
          schemeMonth: 2,
          status: 'SUCCESS',
        });
        expect(extra).toBe(0);
      }
    });

    it('protects late PhonePe success after the month is no longer payable', async () => {
      const now = new Date();
      const startLocal = startOfMonth(addMonths(toZonedTime(now, BUSINESS_TZ), -6));
      const start = fromZonedTime(startLocal, BUSINESS_TZ);
      const fixture = await seedNakshathraEnrollment(start);
      await pay({
        ...fixture,
        amountPaise: 100_000,
        paymentDate: monthDate(fixture.start, 0),
        key: 'late-first',
      });
      await pay({
        ...fixture,
        amountPaise: 100_000,
        paymentDate: now,
        key: 'late-cap-full',
      });
      const [intent] = await PaymentIntent.create([
        {
          customerId: fixture.customer._id,
          schemeId: fixture.enrollment._id,
          amountPaise: 100_000,
          merchantTransactionId: `NKS-LATE-${Date.now()}`,
          checkoutChannel: 'WEB',
          status: 'PENDING',
          idempotencyKey: `idem-late-${Date.now()}`,
          idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
          requestHash: 'phase2-late-hash',
          schemeMonth: 7,
          collectedBy: fixture.admin._id,
          collectorRole: 'CUSTOMER',
          createdBy: fixture.admin._id,
        },
      ]);
      await expect(
        withMongoTransaction(async (session) =>
          finalizeGatewayPayment(
            intent,
            { transactionId: `PP-LATE-${Date.now()}`, amountPaise: 100_000 },
            {
              actorId: String(fixture.admin._id),
              actorRole: 'CUSTOMER',
              requestId: 'late-pp',
            },
            session,
          ),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_LIMIT_EXCEEDED' });
    });
  });

  describe('migration', () => {
    it('drops the unique month index and rewrites live CASH plans without touching enrollments', async () => {
      const { admin } = await seedActor();
      await SchemePlan.collection.insertOne({
        name: 'Legacy Cash',
        type: 'CASH',
        durationMonths: 11,
        redemptionMonth: 12,
        flexibleMonths: 11,
        capMonths: 0,
        minimumPaymentPaise: MIN,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        termsText: 'Legacy 11-flex cash plan',
        version: 1,
        status: 'ACTIVE',
        createdBy: admin._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const [enrollment] = await SchemeEnrollment.create([
        {
          customerId: admin._id,
          schemePlanId: admin._id,
          enrollmentNumber: `NKS-ENR-LEG-${Date.now()}`,
          schemeType: 'CASH',
          startDate: ist('2026-01-01T00:00:00+05:30'),
          ...enrollmentDates(ist('2026-01-01T00:00:00+05:30'), 11, 11),
          durationMonths: 11,
          flexibleMonths: 11,
          capMonths: 0,
          monthlyInstallmentPaise: MIN,
          makingChargeWaiverPercent: 100,
          gstRateBasisPoints: 300,
          status: 'ACTIVE',
          createdBy: admin._id,
        },
      ]);
      const report = await runNakshathraSchemeEngineApply({ ack: MIGRATION_ACK_VALUE });
      expect(report.ok).toBe(true);
      const plan = await SchemePlan.findOne({ name: 'Legacy Cash' });
      expect(plan?.flexibleMonths).toBe(6);
      expect(plan?.capMonths).toBe(5);
      expect(plan?.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
      const unchanged = await SchemeEnrollment.findById(enrollment._id);
      expect(unchanged?.flexibleMonths).toBe(11);
      expect(unchanged?.capMonths).toBe(0);
      const verify = await runNakshathraSchemeEngineVerify();
      expect(verify.ok).toBe(true);
    });
  });

  describe('phase names', () => {
    it('does not copy 11-flexible-month live logic', () => {
      expect(
        resolvePaymentPhase(
          {
            durationMonths: 11,
            flexibleMonths: 6,
            capMonths: 5,
            capStrategy: NAKSHATHRA_CAP_STRATEGY,
          },
          11,
        ).flexibleThroughout,
      ).toBe(false);
    });
  });
});
