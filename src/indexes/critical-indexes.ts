import mongoose from 'mongoose';
import '../models/index.js';
import { AppError } from '../utils/AppError.js';

export type RequiredIndex = {
  /** Stable catalog id used in logs, startup errors, and tests. */
  id: string;
  model: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  /** MongoDB index name after `npm run indexes`. Matching is by key/unique/partial, not name. */
  mongoName: string;
  /** Fail closed on production startup when missing. */
  critical: boolean;
};

export const REQUIRED_INDEXES: RequiredIndex[] = [
  {
    id: 'PAYMENT_MERCHANT_TXN_UNIQUE',
    model: 'Payment',
    key: { merchantTransactionId: 1 },
    unique: true,
    sparse: true,
    mongoName: 'PAYMENT_MERCHANT_TXN_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_PROVIDER_TXN_UNIQUE',
    model: 'Payment',
    key: { providerTransactionId: 1 },
    unique: true,
    sparse: true,
    mongoName: 'PAYMENT_PROVIDER_TXN_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_RECEIPT_NUMBER_UNIQUE',
    model: 'Payment',
    key: { receiptNumber: 1 },
    unique: true,
    sparse: true,
    mongoName: 'PAYMENT_RECEIPT_NUMBER_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_SUCCESS_SCHEME_MONTH',
    model: 'Payment',
    key: { schemeId: 1, schemeMonth: 1 },
    unique: false,
    partialFilterExpression: { status: 'SUCCESS' },
    mongoName: 'PAYMENT_SUCCESS_SCHEME_MONTH',
    critical: true,
  },
  {
    id: 'PAYMENT_INTENT_MERCHANT_TXN_UNIQUE',
    model: 'PaymentIntent',
    key: { merchantTransactionId: 1 },
    unique: true,
    mongoName: 'PAYMENT_INTENT_MERCHANT_TXN_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_INTENT_IDEMPOTENCY_UNIQUE',
    model: 'PaymentIntent',
    key: { customerId: 1, idempotencyScope: 1, idempotencyKey: 1 },
    unique: true,
    mongoName: 'PAYMENT_INTENT_IDEMPOTENCY_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE',
    model: 'PaymentIntent',
    key: { activeAttemptKey: 1 },
    unique: true,
    sparse: true,
    mongoName: 'PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_INTENT_RECOVERY',
    model: 'PaymentIntent',
    key: { status: 1, nextStatusCheckAt: 1, recoveryLockUntil: 1 },
    mongoName: 'PAYMENT_INTENT_RECOVERY',
    critical: false,
  },
  {
    id: 'REFUND_MERCHANT_REFUND_ID_UNIQUE',
    model: 'Refund',
    key: { merchantRefundId: 1 },
    unique: true,
    mongoName: 'merchantRefundId_1',
    critical: true,
  },
  {
    id: 'REFUND_PROVIDER_REFUND_ID_UNIQUE',
    model: 'Refund',
    key: { providerRefundId: 1 },
    unique: true,
    sparse: true,
    mongoName: 'REFUND_PROVIDER_REFUND_ID_UNIQUE',
    critical: true,
  },
  {
    id: 'REFUND_ACTIVE_PER_PAYMENT',
    model: 'Refund',
    key: { paymentId: 1 },
    unique: true,
    partialFilterExpression: { active: true },
    mongoName: 'paymentId_1_active_partial',
    critical: true,
  },
  {
    id: 'REFUND_PAYMENT_ATTEMPT_UNIQUE',
    model: 'Refund',
    key: { paymentId: 1, attemptNumber: 1 },
    unique: true,
    mongoName: 'paymentId_1_attemptNumber_1',
    critical: true,
  },
  {
    id: 'REFUND_ADMIN_IDEMPOTENCY_UNIQUE',
    model: 'Refund',
    key: { requestedBy: 1, idempotencyKey: 1 },
    unique: true,
    mongoName: 'requestedBy_1_idempotencyKey_1',
    critical: true,
  },
  {
    id: 'REFUND_RECOVERY',
    model: 'Refund',
    key: { status: 1, nextStatusCheckAt: 1, recoveryLockUntil: 1 },
    mongoName: 'status_1_nextStatusCheckAt_1_recoveryLockUntil_1',
    critical: false,
  },
  {
    id: 'CUSTOMER_CODE_UNIQUE',
    model: 'Customer',
    key: { customerCode: 1 },
    unique: true,
    mongoName: 'customerCode_1',
    critical: true,
  },
  {
    id: 'USER_PHONE_UNIQUE',
    model: 'User',
    key: { phone: 1 },
    unique: true,
    mongoName: 'phone_1',
    critical: true,
  },
  {
    id: 'ENROLLMENT_NUMBER_UNIQUE',
    model: 'SchemeEnrollment',
    key: { enrollmentNumber: 1 },
    unique: true,
    mongoName: 'ENROLLMENT_NUMBER_UNIQUE',
    critical: true,
  },
  {
    id: 'ENROLLMENT_ONE_ACTIVE_PER_CUSTOMER',
    model: 'SchemeEnrollment',
    key: { customerId: 1 },
    unique: true,
    partialFilterExpression: { status: 'ACTIVE' },
    mongoName: 'ENROLLMENT_ONE_ACTIVE_PER_CUSTOMER',
    critical: true,
  },
  {
    id: 'ACCOUNTING_PERIOD_KEY_UNIQUE',
    model: 'AccountingPeriod',
    key: { periodKey: 1 },
    unique: true,
    mongoName: 'ACCOUNTING_PERIOD_KEY_UNIQUE',
    critical: true,
  },
  {
    id: 'RECEIPT_COUNTER_SCOPE_UNIQUE',
    model: 'ReceiptCounter',
    key: { scope: 1 },
    unique: true,
    mongoName: 'RECEIPT_COUNTER_SCOPE_UNIQUE',
    critical: true,
  },
  {
    id: 'IDEMPOTENCY_RECORD_UNIQUE',
    model: 'IdempotencyRecord',
    key: { actorId: 1, route: 1, key: 1 },
    unique: true,
    mongoName: 'IDEMPOTENCY_RECORD_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYOUT_ONE_SUCCESS_PER_SCHEME',
    model: 'Payout',
    key: { schemeId: 1 },
    unique: true,
    partialFilterExpression: { status: 'SUCCESS' },
    mongoName: 'payout_one_success_per_scheme',
    critical: true,
  },
  {
    id: 'PAYOUT_SCHEME_IDEMPOTENCY_UNIQUE',
    model: 'Payout',
    key: { schemeId: 1, idempotencyKey: 1 },
    unique: true,
    sparse: true,
    mongoName: 'PAYOUT_SCHEME_IDEMPOTENCY_UNIQUE',
    critical: true,
  },
  {
    id: 'OUTBOX_DEDUPE_KEY_UNIQUE',
    model: 'OutboxEvent',
    key: { dedupeKey: 1 },
    unique: true,
    sparse: true,
    mongoName: 'OUTBOX_DEDUPE_KEY_UNIQUE',
    critical: true,
  },
  {
    id: 'GATEWAY_SETTLEMENT_ID_UNIQUE',
    model: 'GatewaySettlement',
    key: { settlementId: 1 },
    unique: true,
    mongoName: 'GATEWAY_SETTLEMENT_ID_UNIQUE',
    critical: true,
  },
  {
    id: 'GOLD_INVENTORY_PAYOUT_UNIQUE',
    model: 'GoldInventoryMovement',
    key: { payoutId: 1 },
    unique: true,
    sparse: true,
    mongoName: 'GOLD_INVENTORY_PAYOUT_UNIQUE',
    critical: true,
  },
  {
    id: 'STAFF_PROFILE_USER_UNIQUE',
    model: 'StaffProfile',
    key: { userId: 1 },
    unique: true,
    mongoName: 'STAFF_PROFILE_USER_UNIQUE',
    critical: true,
  },
  {
    id: 'STAFF_EMPLOYEE_CODE_UNIQUE',
    model: 'StaffProfile',
    key: { employeeCode: 1 },
    unique: true,
    mongoName: 'STAFF_EMPLOYEE_CODE_UNIQUE',
    critical: true,
  },
  {
    id: 'PAYMENT_COLLECTOR_DATE',
    model: 'Payment',
    key: { collectedBy: 1, paymentDate: -1 },
    mongoName: 'PAYMENT_COLLECTOR_DATE',
    critical: false,
  },
  {
    id: 'CASH_SUBMISSION_STAFF_DATE',
    model: 'CashSubmission',
    key: { staffId: 1, submissionDate: -1 },
    mongoName: 'CASH_SUBMISSION_STAFF_DATE',
    critical: false,
  },
  {
    id: 'CORRECTION_STATUS_CREATED',
    model: 'PaymentCorrection',
    key: { status: 1, createdAt: -1 },
    mongoName: 'CORRECTION_STATUS_CREATED',
    critical: false,
  },
  {
    id: 'CORRECTION_PAYMENT_REQUESTER_STATUS',
    model: 'PaymentCorrection',
    key: { paymentId: 1, requestedBy: 1, status: 1 },
    mongoName: 'CORRECTION_PAYMENT_REQUESTER_STATUS',
    critical: false,
  },
  {
    id: 'PAYMENT_GATEWAY_EVENT_PAYLOAD_HASH_UNIQUE',
    model: 'PaymentGatewayEvent',
    key: { payloadHash: 1 },
    unique: true,
    mongoName: 'PAYMENT_GATEWAY_EVENT_PAYLOAD_HASH_UNIQUE',
    critical: true,
  },
];

export type IndexMismatch = {
  id: string;
  model: string;
  reason: string;
};

export type IndexVerifyReport = {
  ok: boolean;
  checked: number;
  mismatches: IndexMismatch[];
};

export function sameIndexKey(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, 1 | -1>,
) {
  if (!actual) return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

function stableValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

export function samePartialFilter(actual: unknown, expected?: Record<string, unknown>) {
  if (!expected) return actual == null;
  if (actual == null) return false;
  return JSON.stringify(stableValue(actual)) === JSON.stringify(stableValue(expected));
}

export function findMatchingIndex(
  indexes: Array<Record<string, any>>,
  required: RequiredIndex,
) {
  return indexes.filter(
    (index) =>
      sameIndexKey(index.key, required.key) &&
      samePartialFilter(index.partialFilterExpression, required.partialFilterExpression),
  );
}

function describeRequired(required: RequiredIndex) {
  const unique = required.unique ? 'unique ' : '';
  const sparse = required.sparse ? 'sparse ' : '';
  const partial = required.partialFilterExpression
    ? ` partial=${JSON.stringify(required.partialFilterExpression)}`
    : '';
  return `${unique}${sparse}key=${JSON.stringify(required.key)}${partial}`;
}

export function evaluateIndexes(
  indexes: Array<Record<string, any>>,
  required: RequiredIndex,
): IndexMismatch | null {
  const matches = findMatchingIndex(indexes, required);
  if (matches.length === 0) {
    return {
      id: required.id,
      model: required.model,
      reason: `${required.id} missing (${describeRequired(required)})`,
    };
  }
  if (required.unique && !matches.some((index) => index.unique === true)) {
    return {
      id: required.id,
      model: required.model,
      reason: `${required.id} is not unique when a uniqueness index is required`,
    };
  }
  if (required.unique === false && !matches.some((index) => index.unique !== true)) {
    return {
      id: required.id,
      model: required.model,
      reason: `${required.id} is unique when a non-unique lookup index is required`,
    };
  }
  if (required.sparse && !matches.some((index) => index.sparse === true)) {
    return {
      id: required.id,
      model: required.model,
      reason: `${required.id} is not sparse when a sparse uniqueness index is required`,
    };
  }
  return null;
}

function modelCollection(modelName: string) {
  const model = mongoose.models[modelName];
  if (!model) {
    throw new Error(`Mongoose model ${modelName} is not registered`);
  }
  return model.collection;
}

export async function verifyRequiredIndexes(options?: {
  criticalOnly?: boolean;
}): Promise<IndexVerifyReport> {
  const required = options?.criticalOnly
    ? REQUIRED_INDEXES.filter((index) => index.critical)
    : REQUIRED_INDEXES;
  const mismatches: IndexMismatch[] = [];

  const byCollection = new Map<string, RequiredIndex[]>();
  for (const index of required) {
    const collectionName = modelCollection(index.model).collectionName;
    byCollection.set(collectionName, [...(byCollection.get(collectionName) ?? []), index]);
  }

  for (const [collectionName, specs] of byCollection) {
    const collection = mongoose.connection.collection(collectionName);
    const indexes = await collection.indexes();
    for (const spec of specs) {
      const mismatch = evaluateIndexes(indexes, spec);
      if (mismatch) mismatches.push(mismatch);
    }
  }

  return {
    ok: mismatches.length === 0,
    checked: required.length,
    mismatches,
  };
}

export async function assertCriticalIndexesPresent() {
  const report = await verifyRequiredIndexes({ criticalOnly: true });
  if (report.ok) return report;
  throw new AppError(
    'INDEX_DEPLOYMENT_INCOMPLETE',
    'Database schema/index deployment is incomplete; refusing financial traffic',
    503,
    false,
    report.mismatches.map((mismatch) => ({
      id: mismatch.id,
      model: mismatch.model,
      reason: mismatch.reason,
    })),
  );
}
