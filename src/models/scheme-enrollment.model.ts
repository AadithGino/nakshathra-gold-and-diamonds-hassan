import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import {
  CAP_STRATEGIES,
  CASH_SETTLEMENT_BASES,
  ENROLLMENT_STATUSES,
  PAYMENT_WINDOW_TYPES,
  PLAN_SNAPSHOT_SOURCES,
  SCHEME_TYPES,
  SETTLEMENT_ASSETS,
} from './enums.js';

const schemeEnrollmentSchema = createSchema({
  customerId: objectIdField('Customer'),
  schemePlanId: objectIdField('SchemePlan'),
  enrollmentNumber: { type: String, required: true },
  schemeType: { type: String, enum: SCHEME_TYPES, required: true },
  startDate: { type: Date, required: true },
  flexiblePeriodEndDate: { type: Date, required: true },
  maturityDate: { type: Date, required: true, index: true },
  redemptionStartDate: { type: Date, required: true, index: true },
  redemptionEndDate: { type: Date, required: true, index: true },
  durationMonths: { type: Number, required: true },
  flexibleMonths: { type: Number, required: true },
  capMonths: { type: Number, min: 0 },
  capStrategy: { type: String, enum: CAP_STRATEGIES },
  contributionPolicyVersion: { type: Number, min: 1 },
  monthlyInstallmentPaise: { type: Number, required: true, min: 100_000 },
  makingChargeWaiverPercent: { type: Number, required: true, min: 100, max: 100, default: 100 },
  gstRateBasisPoints: { type: Number, required: true, min: 300, max: 300, default: 300 },
  schemePlanVersion: { type: Number, min: 1 },
  paymentWindowType: { type: String, enum: PAYMENT_WINDOW_TYPES },
  fixedPaymentDay: { type: Number, min: 1, max: 31 },
  paymentWindowStartDay: { type: Number, min: 1, max: 31 },
  paymentWindowEndDay: { type: Number, min: 1, max: 31 },
  prematureClosureEnabled: { type: Boolean },
  prematureClosureMinPaidInstallments: { type: Number, min: 1, max: 11 },
  prematureClosureSettlementAssets: [{ type: String, enum: SETTLEMENT_ASSETS }],
  maturitySettlementAssets: [{ type: String, enum: SETTLEMENT_ASSETS }],
  prematureClosureCashBasis: { type: String, enum: CASH_SETTLEMENT_BASES },
  maturityCashBasis: { type: String, enum: CASH_SETTLEMENT_BASES },
  planSnapshot: {
    name: String,
    type: { type: String },
    version: Number,
    durationMonths: Number,
    redemptionMonth: Number,
    flexibleMonths: Number,
    capMonths: Number,
    capStrategy: { type: String, enum: CAP_STRATEGIES },
    contributionPolicyVersion: Number,
    minimumPaymentPaise: Number,
    makingChargeWaiverPercent: Number,
    gstRateBasisPoints: Number,
    makingChargeBenefit: String,
    wastageBenefit: String,
    benefitText: String,
    termsText: String,
    paymentWindowType: { type: String, enum: PAYMENT_WINDOW_TYPES },
    fixedPaymentDay: Number,
    paymentWindowStartDay: Number,
    paymentWindowEndDay: Number,
    prematureClosureEnabled: Boolean,
    prematureClosureMinPaidInstallments: Number,
    prematureClosureSettlementAssets: [{ type: String, enum: SETTLEMENT_ASSETS }],
    maturitySettlementAssets: [{ type: String, enum: SETTLEMENT_ASSETS }],
    prematureClosureCashBasis: { type: String, enum: CASH_SETTLEMENT_BASES },
    maturityCashBasis: { type: String, enum: CASH_SETTLEMENT_BASES },
  },
  snapshotSource: { type: String, enum: PLAN_SNAPSHOT_SOURCES },
  snapshotCapturedAt: Date,
  paymentsCompleted: { type: Number, default: 0, min: 0, max: 11 },
  averageMonthlyCapPaise: { type: Number, min: 0 },
  status: { type: String, enum: ENROLLMENT_STATUSES, default: 'ACTIVE', index: true },
  totalPaidPaise: { type: Number, default: 0, min: 0 },
  totalGoldWeightMg: { type: Number, default: 0, min: 0 },
  totalPayoutPaise: { type: Number, default: 0, min: 0 },
  statusHistory: [{ status: String, at: Date, actorId: Schema.Types.ObjectId, reason: String }],
  /** Short-lived mutual exclusion for refund initiation vs redemption. */
  settlementLockedAt: Date,
  settlementLockUntil: Date,
  settlementLockedBy: String,
  createdBy: objectIdField('User'),
  updatedBy: objectIdField('User', false),
});

schemeEnrollmentSchema.index({ customerId: 1, status: 1 });
schemeEnrollmentSchema.index(
  { enrollmentNumber: 1 },
  { unique: true, name: 'ENROLLMENT_NUMBER_UNIQUE' },
);
schemeEnrollmentSchema.index(
  { customerId: 1 },
  {
    unique: true,
    name: 'ENROLLMENT_ONE_ACTIVE_PER_CUSTOMER',
    partialFilterExpression: { status: 'ACTIVE' },
  },
);
schemeEnrollmentSchema.index({ status: 1, schemePlanId: 1, startDate: 1 });
schemeEnrollmentSchema.index({ status: 1, maturityDate: 1 });
schemeEnrollmentSchema.index({
  status: 1,
  paymentsCompleted: 1,
  redemptionStartDate: 1,
  redemptionEndDate: 1,
});

export const SchemeEnrollment = registerModel('SchemeEnrollment', schemeEnrollmentSchema);
