import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { SchemeEnrollment, SchemePlan, Payout, User } from '../src/models/index.js';
import {
  backfillSchemeOperations,
  inspectSchemeOperations,
  runSchemeOperations,
} from '../src/scripts/migrations/2026-08-scheme-operations.js';
import {
  LEGACY_ENROLLMENT_SETTLEMENT_POLICY,
  resolveSettlementPolicy,
  validateSettlementPolicy,
} from '../src/utils/payment-window.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

describe('scheme-operations-legacy-migration', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('keeps empty premature assets on a conservative snapshot instead of granting GOLD+CASH', () => {
    const policy = resolveSettlementPolicy({
      prematureClosureEnabled: false,
      prematureClosureSettlementAssets: [],
      maturitySettlementAssets: ['GOLD'],
    });
    expect(policy.prematureClosureEnabled).toBe(false);
    expect(policy.prematureClosureSettlementAssets).toEqual([]);
    expect(policy.maturitySettlementAssets).toEqual(['GOLD']);
    expect(validateSettlementPolicy({}).prematureClosureEnabled).toBe(true);
    expect(validateSettlementPolicy({}).prematureClosureSettlementAssets).toEqual(['GOLD', 'CASH']);
  });

  it('dry-run reports pending legacy enrollments and warns on upgrade mode', async () => {
    const db = mongoose.connection.db!;
    await db.collection(SchemeEnrollment.collection.collectionName).insertOne({
      enrollmentNumber: 'ENR-LEGACY-1',
      schemeType: 'GOLD_WEIGHT',
      startDate: new Date('2025-01-05T00:00:00.000Z'),
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: 100_000,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
    });
    const dry = await runSchemeOperations('dry-run');
    expect(dry.updatedEnrollments).toBeGreaterThanOrEqual(1);
    expect(dry.legacyCompatibilityPolicy).toBeGreaterThanOrEqual(1);
    expect(dry.enrollmentPolicy).toBe('CONSERVATIVE');

    const upgradeDry = await runSchemeOperations('dry-run', undefined, 'ENABLE_PHASE9_POLICY');
    expect(upgradeDry.rightsUpgradeWarning).toMatch(/ENABLE_PHASE9_POLICY/);
  });

  it('applies conservative policy to legacy enrollments and skips Phase 9 snapshots', async () => {
    const [actor] = await User.create([
      { name: 'Mig Admin', phone: '+917803000001', passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
    ]);
    const db = mongoose.connection.db!;
    const enrollments = db.collection(SchemeEnrollment.collection.collectionName);
    await enrollments.insertOne({
      enrollmentNumber: 'ENR-LEGACY-APPLY',
      schemeType: 'GOLD_WEIGHT',
      startDate: new Date('2025-02-05T00:00:00.000Z'),
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: 100_000,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: actor._id,
    });
    await SchemeEnrollment.create([
      {
        customerId: actor._id,
        schemePlanId: actor._id,
        enrollmentNumber: 'ENR-PHASE9-KEEP',
        schemeType: 'GOLD_WEIGHT',
        startDate: new Date('2026-01-05T00:00:00.000Z'),
        flexiblePeriodEndDate: new Date('2026-12-05T00:00:00.000Z'),
        maturityDate: new Date('2026-12-05T00:00:00.000Z'),
        redemptionStartDate: new Date('2026-12-05T00:00:00.000Z'),
        redemptionEndDate: new Date('2027-01-05T00:00:00.000Z'),
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: 100_000,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        paymentWindowType: 'FIXED_DAY',
        fixedPaymentDay: 5,
        prematureClosureEnabled: true,
        prematureClosureMinPaidInstallments: 1,
        prematureClosureSettlementAssets: ['GOLD', 'CASH'],
        maturitySettlementAssets: ['GOLD', 'CASH'],
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
    await Payout.collection.insertOne({
      customerId: actor._id,
      schemeId: actor._id,
      amountPaise: 100_000,
      payoutType: 'REDEEM',
      method: 'GOLD',
      payoutDate: new Date(),
      status: 'SUCCESS',
    });

    const first = await backfillSchemeOperations(false);
    expect(first.updatedEnrollments).toBe(1);
    expect(first.updatedPayouts).toBe(1);
    const legacy = await enrollments.findOne({ enrollmentNumber: 'ENR-LEGACY-APPLY' });
    expect(legacy?.prematureClosureEnabled).toBe(false);
    expect(legacy?.prematureClosureSettlementAssets).toEqual([]);
    expect(legacy?.maturitySettlementAssets).toEqual(['GOLD']);
    expect(legacy?.prematureClosureCashBasis).toBe('CONTRIBUTION_VALUE');
    const kept = await SchemeEnrollment.findOne({ enrollmentNumber: 'ENR-PHASE9-KEEP' });
    expect(kept?.prematureClosureEnabled).toBe(true);
    expect(kept?.maturitySettlementAssets).toEqual(['GOLD', 'CASH']);
    const payout = await Payout.collection.findOne({ amountPaise: 100_000 });
    expect(payout?.settlementPrincipalPaise).toBe(100_000);

    const second = await backfillSchemeOperations(false);
    expect(second.updatedEnrollments).toBe(0);
    expect(second.updatedPayouts).toBe(0);
    expect(LEGACY_ENROLLMENT_SETTLEMENT_POLICY.prematureClosureEnabled).toBe(false);

    const inspect = await inspectSchemeOperations();
    expect(inspect.pendingEnrollments).toBe(0);
  });

  it('ENABLE_PHASE9_POLICY backfills NEW defaults onto legacy enrollments', async () => {
    const db = mongoose.connection.db!;
    await db.collection(SchemeEnrollment.collection.collectionName).insertOne({
      enrollmentNumber: 'ENR-UPGRADE',
      schemeType: 'GOLD_WEIGHT',
      startDate: new Date('2025-03-05T00:00:00.000Z'),
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: 100_000,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
    });
    await backfillSchemeOperations(false, 'ENABLE_PHASE9_POLICY');
    const upgraded = await db
      .collection(SchemeEnrollment.collection.collectionName)
      .findOne({ enrollmentNumber: 'ENR-UPGRADE' });
    expect(upgraded?.prematureClosureEnabled).toBe(true);
    expect(upgraded?.prematureClosureSettlementAssets).toEqual(['GOLD', 'CASH']);
    expect(upgraded?.maturitySettlementAssets).toEqual(['GOLD', 'CASH']);
  });
});
