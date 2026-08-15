import {
  NAKSHATHRA_CAP_STRATEGY,
  NAKSHATHRA_CAPPED_MONTHS,
  NAKSHATHRA_DURATION_MONTHS,
  NAKSHATHRA_FLEXIBLE_MONTHS,
  NAKSHATHRA_MINIMUM_PAYMENT_PAISE,
  NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS,
  NAKSHATHRA_REDEMPTION_MONTH,
} from '../config/business.js';
import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import {
  CAP_STRATEGIES,
  CASH_SETTLEMENT_BASES,
  PAYMENT_WINDOW_TYPES,
  SCHEME_TYPES,
  SETTLEMENT_ASSETS,
} from './enums.js';

const schemePlanSchema = createSchema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: SCHEME_TYPES, required: true, index: true },
  durationMonths: {
    type: Number,
    required: true,
    min: NAKSHATHRA_DURATION_MONTHS,
    max: NAKSHATHRA_DURATION_MONTHS,
    default: NAKSHATHRA_DURATION_MONTHS,
  },
  redemptionMonth: {
    type: Number,
    required: true,
    min: NAKSHATHRA_REDEMPTION_MONTH,
    max: NAKSHATHRA_REDEMPTION_MONTH,
    default: NAKSHATHRA_REDEMPTION_MONTH,
  },
  flexibleMonths: {
    type: Number,
    required: true,
    min: NAKSHATHRA_FLEXIBLE_MONTHS,
    max: NAKSHATHRA_DURATION_MONTHS,
    default: NAKSHATHRA_FLEXIBLE_MONTHS,
  },
  capMonths: {
    type: Number,
    required: true,
    min: 0,
    max: NAKSHATHRA_CAPPED_MONTHS,
    default: NAKSHATHRA_CAPPED_MONTHS,
  },
  capStrategy: {
    type: String,
    enum: CAP_STRATEGIES,
  },
  contributionPolicyVersion: {
    type: Number,
    min: 1,
  },
  minimumPaymentPaise: {
    type: Number,
    required: true,
    min: NAKSHATHRA_MINIMUM_PAYMENT_PAISE,
    default: NAKSHATHRA_MINIMUM_PAYMENT_PAISE,
  },
  makingChargeWaiverPercent: { type: Number, required: true, min: 100, max: 100, default: 100 },
  gstRateBasisPoints: { type: Number, required: true, min: 300, max: 300, default: 300 },
  makingChargeBenefit: String,
  wastageBenefit: String,
  benefitText: String,
  termsText: { type: String, required: true },
  version: { type: Number, required: true, min: 1, default: 1 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  paymentWindowType: {
    type: String,
    enum: PAYMENT_WINDOW_TYPES,
    default: 'FIXED_DAY',
  },
  fixedPaymentDay: { type: Number, min: 1, max: 31 },
  paymentWindowStartDay: { type: Number, min: 1, max: 31 },
  paymentWindowEndDay: { type: Number, min: 1, max: 31 },
  prematureClosureEnabled: { type: Boolean, default: true },
  prematureClosureMinPaidInstallments: { type: Number, min: 1, max: 11, default: 1 },
  prematureClosureMinElapsedMonths: { type: Number, min: 1, max: 11 },
  prematureClosureSettlementAssets: {
    type: [{ type: String, enum: SETTLEMENT_ASSETS }],
    default: () => ['GOLD', 'CASH'],
  },
  maturitySettlementAssets: {
    type: [{ type: String, enum: SETTLEMENT_ASSETS }],
    default: () => ['GOLD', 'CASH'],
  },
  prematureClosureCashBasis: {
    type: String,
    enum: CASH_SETTLEMENT_BASES,
    default: 'CONTRIBUTION_VALUE',
  },
  maturityCashBasis: {
    type: String,
    enum: CASH_SETTLEMENT_BASES,
    default: 'CONTRIBUTION_VALUE',
  },
  createdBy: objectIdField('User'),
  updatedBy: objectIdField('User', false),
  deletedAt: Date,
});

schemePlanSchema.pre('validate', function validateNakshathraSchemeWindow(this: any) {
  if (
    this.durationMonths !== NAKSHATHRA_DURATION_MONTHS ||
    this.redemptionMonth !== NAKSHATHRA_REDEMPTION_MONTH
  ) {
    this.invalidate(
      'durationMonths',
      'Schemes require 11 contribution months followed by redemption in month 12',
    );
    return;
  }
  if (Number(this.flexibleMonths) + Number(this.capMonths) !== NAKSHATHRA_DURATION_MONTHS) {
    this.invalidate(
      'flexibleMonths',
      'flexibleMonths + capMonths must equal 11 contribution months',
    );
  }
  if (this.type === 'CASH') {
    if (
      this.flexibleMonths !== NAKSHATHRA_FLEXIBLE_MONTHS ||
      this.capMonths !== NAKSHATHRA_CAPPED_MONTHS
    ) {
      this.invalidate(
        'flexibleMonths',
        'Live CASH schemes use 6 flexible months and 5 capped months',
      );
    }
    if (this.capStrategy !== NAKSHATHRA_CAP_STRATEGY) {
      this.invalidate(
        'capStrategy',
        `Live CASH schemes require capStrategy ${NAKSHATHRA_CAP_STRATEGY}`,
      );
    }
    this.prematureClosureSettlementAssets = ['CASH'];
    this.maturitySettlementAssets = ['CASH', 'JEWELLERY'];
    this.prematureClosureMinElapsedMonths = NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS;
    this.prematureClosureCashBasis = 'CONTRIBUTION_VALUE';
    this.maturityCashBasis = 'CONTRIBUTION_VALUE';
  }
});

schemePlanSchema.index({ status: 1, createdAt: -1 });

export const SchemePlan = registerModel('SchemePlan', schemePlanSchema);
