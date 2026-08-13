import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import mongoose from 'mongoose';
import {
  AuditLog,
  Customer,
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  SchemePlan,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { createCustomer, rejectCustomerKyc, updateCustomer, verifyCustomerKyc } from '../src/services/customer.service.js';
import { createEnrollment, createSchemePlan, getEnrollmentDetails, updateSchemePlan } from '../src/services/scheme-management.service.js';
import { createManualPayment, finalizeGatewayPayment } from '../src/services/payment.service.js';
import { initiatePhonePe } from '../src/services/gateway.service.js';
import { finalizeSuccessfulRefund, initiatePaymentRefund } from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import * as storageService from '../src/services/storage.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import {
  MIGRATION_ACK_VALUE,
  runEnrollmentPlanSnapshotsApply,
  runEnrollmentPlanSnapshotsDryRun,
  runEnrollmentPlanSnapshotsVerify,
} from '../src/scripts/migrations/2026-08-enrollment-plan-snapshots.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
const AADHAAR_FRONT = 'jewellers/nakshathra-jewellery/aadhaar-front/front.jpg';
const AADHAAR_BACK = 'jewellers/nakshathra-jewellery/aadhaar-back/back.jpg';
const AADHAAR_FRONT_REPLACEMENT = 'jewellers/nakshathra-jewellery/aadhaar-front/front-2.jpg';

let phoneSeq = 0;
function nextPhone() {
  phoneSeq += 1;
  return `+9170${String(phoneSeq).padStart(8, '0')}`;
}

const adminCtx = (actorId: string, requestId: string) => ({
  actorId,
  actorRole: 'ADMIN' as const,
  requestId,
});

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'P5 Admin',
      phone: nextPhone(),
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedCustomer(opts?: {
  kycStatus?: 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  status?: 'ACTIVE' | 'INACTIVE';
  userStatus?: 'ACTIVE' | 'INACTIVE';
  aadhaar?: { frontKey?: string; backKey?: string };
  adminId?: unknown;
}) {
  const adminId = opts?.adminId ?? (await seedAdmin())._id;
  const [user] = await User.create([
    {
      name: 'P5 Customer',
      phone: nextPhone(),
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: opts?.userStatus ?? 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: `CUST-P5-${Date.now()}-${phoneSeq}`,
      status: opts?.status ?? 'ACTIVE',
      kycStatus: opts?.kycStatus ?? 'NOT_SUBMITTED',
      aadhaar: opts?.aadhaar,
      createdBy: adminId,
    },
  ]);
  return { adminId, user, customer };
}

async function seedPlan(adminId: unknown, extras?: Record<string, unknown>) {
  return createSchemePlan(
    {
      name: 'Kairali Gold 11',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: INSTALLMENT,
      termsText: 'Original v1 terms. Eleven installments then redemption.',
      benefitText: 'Original v1 benefit',
      makingChargeBenefit: 'Original making waiver',
      wastageBenefit: 'Original wastage',
      ...extras,
    },
    adminCtx(String(adminId), `p5-plan-${phoneSeq}`),
  );
}

async function seedGoldAndGateway(adminId: unknown) {
  const { start: todayStart } = businessDayRange(new Date());
  await GoldRate.create([
    {
      ratePerGramPaise: 700_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: adminId,
    },
  ]);
  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);
}

describe('Phase 5 — scheme version snapshot + KYC + inactive policy', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    vi.restoreAllMocks();
    vi.spyOn(storageService, 'signAadhaarUrls').mockImplementation(async (aadhaar) => ({
      frontKey: aadhaar?.frontKey ?? null,
      backKey: aadhaar?.backKey ?? null,
      frontUrl: aadhaar?.frontKey ? 'https://signed.example/front' : null,
      backUrl: aadhaar?.backKey ? 'https://signed.example/back' : null,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('snapshots plan v1 on enrollment and keeps it after the live plan moves to v2', async () => {
    const admin = await seedAdmin();
    const { customer } = await seedCustomer({ kycStatus: 'VERIFIED', adminId: admin._id });
    const plan = await seedPlan(admin._id);
    expect(plan.version).toBe(1);

    const enrollment = await createEnrollment(
      {
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: new Date(),
        monthlyInstallmentPaise: INSTALLMENT,
      },
      adminCtx(String(admin._id), 'p5-enroll-v1'),
    );
    expect(enrollment.schemePlanVersion).toBe(1);
    expect(enrollment.snapshotSource).toBe('ENROLLMENT');
    expect(enrollment.planSnapshot.version).toBe(1);
    expect(enrollment.planSnapshot.termsText).toContain('Original v1 terms');
    expect(enrollment.planSnapshot.benefitText).toBe('Original v1 benefit');
    expect(enrollment.planSnapshot.makingChargeBenefit).toBe('Original making waiver');
    expect(enrollment.planSnapshot.wastageBenefit).toBe('Original wastage');
    expect(enrollment.planSnapshot.minimumPaymentPaise).toBe(INSTALLMENT);

    const updated = await updateSchemePlan(
      String(plan._id),
      {
        name: 'Kairali Gold 11 Revised',
        termsText: 'Mutated v2 terms must not leak into existing enrollments.',
        benefitText: 'Mutated v2 benefit',
        makingChargeBenefit: 'Mutated making',
        wastageBenefit: 'Mutated wastage',
        minimumPaymentPaise: 200_000,
      },
      adminCtx(String(admin._id), 'p5-plan-v2'),
    );
    expect(updated.version).toBe(2);
    expect(updated.termsText).toContain('Mutated v2 terms');

    const details = await getEnrollmentDetails(String(enrollment._id));
    expect(details.enrollment.schemePlanVersion).toBe(1);
    expect(details.enrollment.schemeContract.version).toBe(1);
    expect(details.enrollment.schemeContract.termsText).toContain('Original v1 terms');
    expect(details.enrollment.schemeContract.benefitText).toBe('Original v1 benefit');
    expect(details.enrollment.schemeContract.makingChargeBenefit).toBe('Original making waiver');
    expect(details.enrollment.schemeContract.wastageBenefit).toBe('Original wastage');
    expect(details.enrollment.schemeContract.minimumPaymentPaise).toBe(INSTALLMENT);
    expect(details.enrollment.schemeName).toBe('Kairali Gold 11');

    const stored = await SchemeEnrollment.findById(enrollment._id).lean();
    expect(stored?.planSnapshot.termsText).toContain('Original v1 terms');
    expect(stored?.monthlyInstallmentPaise).toBe(INSTALLMENT);

    const { customer: customerTwo } = await seedCustomer({
      kycStatus: 'VERIFIED',
      adminId: admin._id,
    });
    const later = await createEnrollment(
      {
        customerId: String(customerTwo._id),
        schemePlanId: String(plan._id),
        startDate: new Date(),
        monthlyInstallmentPaise: 200_000,
      },
      adminCtx(String(admin._id), 'p5-enroll-v2'),
    );
    expect(later.schemePlanVersion).toBe(2);
    expect(later.planSnapshot.termsText).toContain('Mutated v2 terms');
    expect(later.planSnapshot.benefitText).toBe('Mutated v2 benefit');
  });

  it('starts KYC as NOT_SUBMITTED and moves to PENDING when both Aadhaar docs exist', async () => {
    const admin = await seedAdmin();
    const created = await createCustomer(
      {
        name: 'No Docs Customer',
        phone: nextPhone(),
        password: 'Password123!',
      },
      adminCtx(String(admin._id), 'p5-kyc-create'),
    );
    expect(created.customer.kycStatus).toBe('NOT_SUBMITTED');

    const pendingCreate = await createCustomer(
      {
        name: 'Docs Customer',
        phone: nextPhone(),
        password: 'Password123!',
        aadhaar: { frontKey: AADHAAR_FRONT, backKey: AADHAAR_BACK },
      },
      adminCtx(String(admin._id), 'p5-kyc-pending-create'),
    );
    expect(pendingCreate.customer.kycStatus).toBe('PENDING');
    expect(pendingCreate.customer.kycSubmittedAt).toBeTruthy();
  });

  it('verifies pending KYC and requires a reason to reject', async () => {
    const admin = await seedAdmin();
    const { customer } = await seedCustomer({
      kycStatus: 'PENDING',
      aadhaar: { frontKey: AADHAAR_FRONT, backKey: AADHAAR_BACK },
      adminId: admin._id,
    });

    const verified = await verifyCustomerKyc(
      String(customer._id),
      adminCtx(String(admin._id), 'p5-kyc-verify'),
    );
    expect(verified.customer.kycStatus).toBe('VERIFIED');
    expect(verified.customer.kycReviewedBy).toBeTruthy();
    expect(verified.customer.kycRejectionReason).toBeFalsy();
    expect(await AuditLog.findOne({ action: 'KYC_VERIFIED', entityId: customer._id })).toBeTruthy();

    await expect(
      rejectCustomerKyc(String(customer._id), '   ', adminCtx(String(admin._id), 'p5-kyc-blank')),
    ).rejects.toMatchObject({ code: 'KYC_REJECTION_REASON_REQUIRED' });

    const rejected = await rejectCustomerKyc(
      String(customer._id),
      'Document mismatch',
      adminCtx(String(admin._id), 'p5-kyc-reject'),
    );
    expect(rejected.customer.kycStatus).toBe('REJECTED');
    expect(rejected.customer.kycRejectionReason).toBe('Document mismatch');
  });

  it('returns rejected and verified customers to PENDING when Aadhaar docs are replaced', async () => {
    const admin = await seedAdmin();
    const created = await createCustomer(
      {
        name: 'Replace Docs',
        phone: nextPhone(),
        password: 'Password123!',
        aadhaar: { frontKey: AADHAAR_FRONT, backKey: AADHAAR_BACK },
      },
      adminCtx(String(admin._id), 'p5-kyc-replace-create'),
    );
    const customerId = String(created.customer._id);

    await rejectCustomerKyc(customerId, 'Unreadable scan', adminCtx(String(admin._id), 'p5-kyc-rej'));
    const afterRejectReplace = await updateCustomer(
      customerId,
      { aadhaar: { frontKey: AADHAAR_FRONT_REPLACEMENT } },
      adminCtx(String(admin._id), 'p5-kyc-rej-replace'),
    );
    expect(afterRejectReplace.customer.kycStatus).toBe('PENDING');

    await verifyCustomerKyc(customerId, adminCtx(String(admin._id), 'p5-kyc-reverify'));
    const afterVerifiedReplace = await updateCustomer(
      customerId,
      { aadhaar: { backKey: `${AADHAAR_BACK}-new` } },
      adminCtx(String(admin._id), 'p5-kyc-ver-replace'),
    );
    expect(afterVerifiedReplace.customer.kycStatus).toBe('PENDING');
    expect(await AuditLog.findOne({ action: 'KYC_DOCUMENTS_SUBMITTED', entityId: created.customer._id })).toBeTruthy();
  });

  it('blocks nested createCustomer enrollment unless KYC is already verified', async () => {
    const admin = await seedAdmin();
    const plan = await seedPlan(admin._id);
    await expect(
      createCustomer(
        {
          name: 'Half Created',
          phone: nextPhone(),
          password: 'Password123!',
          enrollment: {
            schemePlanId: String(plan._id),
            startDate: new Date(),
            monthlyInstallmentPaise: INSTALLMENT,
          },
        },
        adminCtx(String(admin._id), 'p5-nested-enroll'),
      ),
    ).rejects.toMatchObject({ code: 'KYC_VERIFICATION_REQUIRED' });

    expect(await Customer.countDocuments({})).toBe(0);
    expect(await SchemeEnrollment.countDocuments({})).toBe(0);
    expect(await User.countDocuments({ role: 'CUSTOMER' })).toBe(0);
  });

  it('blocks unverified and inactive customers from new inbound financial activity', async () => {
    const admin = await seedAdmin();
    const plan = await seedPlan(admin._id);
    await seedGoldAndGateway(admin._id);
    const { customer: unverified, user: unverifiedUser } = await seedCustomer({
      kycStatus: 'NOT_SUBMITTED',
      adminId: admin._id,
    });
    const { customer: inactive, user: inactiveUser } = await seedCustomer({
      kycStatus: 'VERIFIED',
      status: 'INACTIVE',
      adminId: admin._id,
    });
    const { customer: verified, user: verifiedUser } = await seedCustomer({
      kycStatus: 'VERIFIED',
      adminId: admin._id,
    });

    const now = new Date();
    const dates = enrollmentDates(now, 11, 11);
    const enrollUnverified = async () =>
      createEnrollment(
        {
          customerId: String(unverified._id),
          schemePlanId: String(plan._id),
          startDate: now,
          monthlyInstallmentPaise: INSTALLMENT,
        },
        adminCtx(String(admin._id), 'p5-enroll-unverified'),
      );
    await expect(enrollUnverified()).rejects.toMatchObject({ code: 'KYC_VERIFICATION_REQUIRED' });
    await expect(
      createEnrollment(
        {
          customerId: String(inactive._id),
          schemePlanId: String(plan._id),
          startDate: now,
          monthlyInstallmentPaise: INSTALLMENT,
        },
        adminCtx(String(admin._id), 'p5-enroll-inactive'),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });

    const verifiedEnrollment = await createEnrollment(
      {
        customerId: String(verified._id),
        schemePlanId: String(plan._id),
        startDate: now,
        monthlyInstallmentPaise: INSTALLMENT,
      },
      adminCtx(String(admin._id), 'p5-enroll-verified'),
    );

    const [unverifiedScheme] = await SchemeEnrollment.create([
      {
        customerId: unverified._id,
        schemePlanId: plan._id,
        enrollmentNumber: `ENR-P5-U-${phoneSeq}`,
        schemeType: 'GOLD_WEIGHT',
        startDate: now,
        ...dates,
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: INSTALLMENT,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);
    const [inactiveScheme] = await SchemeEnrollment.create([
      {
        customerId: inactive._id,
        schemePlanId: plan._id,
        enrollmentNumber: `ENR-P5-I-${phoneSeq}`,
        schemeType: 'GOLD_WEIGHT',
        startDate: now,
        ...dates,
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: INSTALLMENT,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);

    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      throw new Error('PhonePe must not be called for blocked customers');
    });

    await expect(
      initiatePhonePe(
        String(unverifiedUser._id),
        {
          schemeId: String(unverifiedScheme._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'p5-phonepe-unverified',
        },
        'p5-pp-u',
      ),
    ).rejects.toMatchObject({ code: 'KYC_VERIFICATION_REQUIRED' });
    await expect(
      initiatePhonePe(
        String(inactiveUser._id),
        {
          schemeId: String(inactiveScheme._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'p5-phonepe-inactive',
        },
        'p5-pp-i',
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });

    await expect(
      createManualPayment(
        {
          customerId: String(unverified._id),
          schemeId: String(unverifiedScheme._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          method: 'CASH',
          paymentDate: now,
          idempotencyKey: 'p5-manual-unverified',
        },
        adminCtx(String(admin._id), 'p5-man-u'),
      ),
    ).rejects.toMatchObject({ code: 'KYC_VERIFICATION_REQUIRED' });
    await expect(
      createManualPayment(
        {
          customerId: String(inactive._id),
          schemeId: String(inactiveScheme._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          method: 'CASH',
          paymentDate: now,
          idempotencyKey: 'p5-manual-inactive',
        },
        adminCtx(String(admin._id), 'p5-man-i'),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });

    vi.spyOn(phonePeProvider, 'createPayment').mockResolvedValue({
      providerOrderId: 'ORD-P5-OK',
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 900_000),
    });
    const phonePe = await initiatePhonePe(
      String(verifiedUser._id),
      {
        schemeId: String(verifiedEnrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'p5-phonepe-verified',
      },
      'p5-pp-v',
      'http://localhost:5173',
    );
    expect(phonePe).toBeTruthy();

    const manual = await createManualPayment(
      {
        customerId: String(verified._id),
        schemeId: String(verifiedEnrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        method: 'CASH',
        paymentDate: now,
        idempotencyKey: 'p5-manual-verified',
      },
      adminCtx(String(admin._id), 'p5-man-v'),
    );
    expect(manual.status).toBe('SUCCESS');
  });

  it('finalizes a provider-confirmed payment after KYC later becomes non-verified', async () => {
    const admin = await seedAdmin();
    const { customer, user } = await seedCustomer({ kycStatus: 'VERIFIED', adminId: admin._id });
    const plan = await seedPlan(admin._id);
    await seedGoldAndGateway(admin._id);
    const now = new Date();
    const dates = enrollmentDates(now, 11, 11);
    const [enrollment] = await SchemeEnrollment.create([
      {
        customerId: customer._id,
        schemePlanId: plan._id,
        enrollmentNumber: `ENR-P5-FIN-${phoneSeq}`,
        schemeType: 'GOLD_WEIGHT',
        startDate: now,
        ...dates,
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: INSTALLMENT,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);
    const goldRate = await GoldRate.findOne({ status: 'ACTIVE' });
    const merchantTransactionId = `KRL-P5-FIN-${Date.now()}`;
    const [intent] = await PaymentIntent.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: `p5-fin-${Date.now()}`,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'p5-fin-hash',
        goldRateId: goldRate!._id,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: user._id,
      },
    ]);

    await Customer.updateOne({ _id: customer._id }, { $set: { kycStatus: 'REJECTED' } });

    const payment = await finalizeGatewayPayment(
      intent,
      {
        transactionId: 'PP-P5-FIN',
        amountPaise: INSTALLMENT,
        providerCompletedAt: now,
      },
      { actorId: String(user._id), actorRole: 'CUSTOMER', requestId: 'p5-fin' },
    );
    expect(payment.status).toBe('SUCCESS');
    expect(payment.amountPaise).toBe(INSTALLMENT);
  });

  it('still refunds unverified inactive customers and does not zero existing gold', async () => {
    const admin = await seedAdmin();
    const { customer } = await seedCustomer({
      kycStatus: 'VERIFIED',
      adminId: admin._id,
    });
    const plan = await seedPlan(admin._id);
    const now = new Date();
    const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
    const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
    const dates = enrollmentDates(startDate, 11, 11);
    const [enrollment] = await SchemeEnrollment.create([
      {
        customerId: customer._id,
        schemePlanId: plan._id,
        enrollmentNumber: `ENR-P5-RFD-${phoneSeq}`,
        schemeType: 'GOLD_WEIGHT',
        startDate,
        ...dates,
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: INSTALLMENT,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        status: 'ACTIVE',
        totalPaidPaise: INSTALLMENT,
        totalGoldWeightMg: 142,
        paymentsCompleted: 1,
        createdBy: admin._id,
      },
    ]);
    const merchantTransactionId = `KRL-P5-RFD-${Date.now()}`;
    await PaymentIntent.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId,
        checkoutChannel: 'WEB',
        status: 'SUCCESS',
        idempotencyKey: `p5-rfd-${merchantTransactionId}`,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'p5-rfd-hash',
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: admin._id,
      },
    ]);
    const [payment] = await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: now,
        schemeMonth: 1,
        receiptNumber: `KRL-P5-RFD-${phoneSeq}`,
        merchantTransactionId,
        providerTransactionId: `PP-${merchantTransactionId}`,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        collectorRole: 'CUSTOMER',
        createdBy: admin._id,
      },
    ]);

    await Customer.updateOne(
      { _id: customer._id },
      { $set: { status: 'INACTIVE', kycStatus: 'NOT_SUBMITTED' } },
    );
    await User.updateOne({ _id: customer.userId }, { $set: { status: 'INACTIVE' } });

    const frozen = await SchemeEnrollment.findById(enrollment._id).lean();
    expect(frozen?.totalPaidPaise).toBe(INSTALLMENT);
    expect(frozen?.totalGoldWeightMg).toBe(142);

    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-P5-1',
      raw: { state: 'PENDING' },
    });
    const initiated = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Inactive customer refund', idempotencyKey: 'p5-refund-inactive' },
      adminCtx(String(admin._id), 'p5-rfd-init'),
    );
    expect(initiated.status).toBe('PENDING');

    const completed = await finalizeSuccessfulRefund(
      String(initiated.refundId),
      {
        state: 'SUCCESS',
        amountPaise: INSTALLMENT,
        providerRefundId: 'PRV-P5-DONE',
        bankReferenceId: 'UTR-P5',
        railType: 'UPI',
        raw: { state: 'SUCCESS' },
      },
      adminCtx(String(admin._id), 'p5-rfd-fin'),
    );
    expect(completed.status).toBe('SUCCESS');
  });

  it('backfills legacy enrollment snapshots without changing financial totals and is rerunnable', async () => {
    const admin = await seedAdmin();
    const [plan] = await SchemePlan.create([
      {
        name: 'Legacy Plan',
        type: 'GOLD_WEIGHT',
        durationMonths: 11,
        redemptionMonth: 12,
        flexibleMonths: 11,
        capMonths: 0,
        minimumPaymentPaise: INSTALLMENT,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        termsText: 'Current live terms used only as a legacy backfill source.',
        benefitText: 'Current live benefit',
        makingChargeBenefit: 'Current making',
        wastageBenefit: 'Current wastage',
        version: 4,
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);
    const now = new Date();
    const dates = enrollmentDates(now, 11, 11);
    const collection = mongoose.connection.db!.collection(SchemeEnrollment.collection.collectionName);
    const inserted = await collection.insertOne({
      customerId: admin._id,
      schemePlanId: plan._id,
      enrollmentNumber: `ENR-P5-LEGACY-${Date.now()}`,
      schemeType: 'GOLD_WEIGHT',
      startDate: now,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      totalPaidPaise: 500_000,
      totalGoldWeightMg: 710,
      paymentsCompleted: 5,
      createdBy: admin._id,
      createdAt: now,
      updatedAt: now,
    });

    const dry = await runEnrollmentPlanSnapshotsDryRun();
    expect(dry.updated).toBe(1);
    expect(dry.ok).toBe(true);

    const applied = await runEnrollmentPlanSnapshotsApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.updated).toBe(1);
    expect(applied.ok).toBe(true);

    const doc = await collection.findOne({ _id: inserted.insertedId });
    expect(doc?.totalPaidPaise).toBe(500_000);
    expect(doc?.totalGoldWeightMg).toBe(710);
    expect(doc?.monthlyInstallmentPaise).toBe(INSTALLMENT);
    expect(doc?.status).toBe('ACTIVE');
    expect(doc?.paymentsCompleted).toBe(5);
    expect(doc?.snapshotSource).toBe('LEGACY_BACKFILL');
    expect(doc?.schemePlanVersion).toBe(4);
    expect(doc?.planSnapshot.version).toBe(4);
    expect(doc?.planSnapshot.termsText).toContain('legacy backfill source');
    expect(doc?.planSnapshot.benefitText).toBe('Current live benefit');

    const again = await runEnrollmentPlanSnapshotsApply({
      ack: MIGRATION_ACK_VALUE,
      resume: true,
    });
    expect(again.updated).toBe(0);

    const verified = await runEnrollmentPlanSnapshotsVerify();
    expect(verified.ok).toBe(true);
    expect(verified.verificationErrors).toEqual([]);

    const details = await getEnrollmentDetails(String(inserted.insertedId));
    expect(details.enrollment.schemeContract.version).toBe(4);
    expect(details.enrollment.schemeName).toBe('Legacy Plan');
  });
});
