import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import { formatReceiptNumber } from '../config/business.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';
import { paise } from '../utils/money.js';
import { withMongoTransaction } from '../utils/transaction.js';
import {
  Customer,
  GoldRate,
  IdempotencyRecord,
  Payment,
  PaymentIntent,
  Payout,
  ReceiptCounter,
} from '../models/index.js';
import { activeGoldRate, getPaymentRules, goldWeightMg, resolveTargetSchemeMonth } from './scheme.service.js';
import { buildContributionStatus } from './contribution-status.service.js';
import { audit, outbox, type AuditContext } from './audit.service.js';
import {
  claimEnrollmentSettlementLock,
  clearEnrollmentSettlementLock,
  SETTLEMENT_LOCK_PAYMENT_STATUSES,
  syncEnrollmentFromLedger,
} from '../utils/enrollment-ledger.js';
import { assertDateInOpenPeriod, resolveGatewayAccountingDate, toPeriodKey } from './accounting-period.service.js';
import { upsertFinancialException } from './financial-exception.service.js';
import { assertCustomerCanStartFinancialActivity } from './customer-financial-policy.service.js';
import { businessYear } from '../utils/time.js';

export type ManualPaymentInput = {
  customerId: string;
  schemeId: string;
  amountPaise: number;
  schemeMonth?: number;
  method: 'CASH' | 'UPI' | 'BANK' | 'CARD';
  paymentDate: Date;
  referenceNumber?: string;
  notes?: string;
  idempotencyKey: string;
};
const requestHash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Short lease — crash recovery must not wait for the 24h TTL. */
export const MANUAL_IDEMPOTENCY_LEASE_MS = 120_000;
const MANUAL_IDEMPOTENCY_TTL_MS = 86_400_000;
const MANUAL_IDEMPOTENCY_POLL_ATTEMPTS = 50;
const MANUAL_IDEMPOTENCY_POLL_MS = 100;

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessingLeaseExpired(
  record: { state?: string; processingLockUntil?: Date | null },
  now = new Date(),
) {
  if (record.state !== 'PROCESSING') return false;
  // Legacy PROCESSING rows created before leases are immediately reclaimable.
  if (record.processingLockUntil == null) return true;
  return new Date(record.processingLockUntil).getTime() <= now.getTime();
}

/**
 * Atomic idempotency claim outside the payment transaction.
 * Concurrent identical keys: one winner proceeds; others wait for COMPLETED or get a clean retryable 409.
 * Stale/missing PROCESSING leases are reclaimed so a crash cannot block the key for 24h.
 */
async function claimOrLoadManualIdempotency(
  actorId: string,
  key: string,
  input: unknown,
): Promise<
  | { kind: 'claimed'; record: any }
  | { kind: 'completed'; response: unknown }
> {
  const hash = requestHash(input);
  const filter = { actorId, route: 'manual-payment', key };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MANUAL_IDEMPOTENCY_TTL_MS);
  const lockUntil = new Date(now.getTime() + MANUAL_IDEMPOTENCY_LEASE_MS);

  try {
    const [created] = await IdempotencyRecord.create([
      {
        actorId,
        route: 'manual-payment',
        key,
        requestHash: hash,
        state: 'PROCESSING',
        processingLockedAt: now,
        processingLockUntil: lockUntil,
        expiresAt,
      },
    ]);
    return { kind: 'claimed', record: created };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  for (let attempt = 0; attempt < MANUAL_IDEMPOTENCY_POLL_ATTEMPTS; attempt++) {
    const existing = await IdempotencyRecord.findOne(filter);
    if (!existing) {
      await sleep(MANUAL_IDEMPOTENCY_POLL_MS);
      continue;
    }
    if (existing.requestHash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was reused with different data',
        409,
      );
    }
    if (existing.state === 'COMPLETED') {
      return { kind: 'completed', response: existing.responseBody };
    }

    const pollNow = new Date();
    if (isProcessingLeaseExpired(existing, pollNow)) {
      const reclaimed = await IdempotencyRecord.findOneAndUpdate(
        mongoose.trusted({
          actorId,
          route: 'manual-payment',
          key,
          state: 'PROCESSING',
          requestHash: hash,
          $or: [
            { processingLockUntil: null },
            { processingLockUntil: mongoose.trusted({ $exists: false }) },
            { processingLockUntil: mongoose.trusted({ $lte: pollNow }) },
          ],
        }),
        {
          $set: {
            processingLockedAt: pollNow,
            processingLockUntil: new Date(pollNow.getTime() + MANUAL_IDEMPOTENCY_LEASE_MS),
            expiresAt: new Date(pollNow.getTime() + MANUAL_IDEMPOTENCY_TTL_MS),
          },
        },
        { new: true },
      );
      if (reclaimed) {
        return { kind: 'claimed', record: reclaimed };
      }
    }

    await sleep(MANUAL_IDEMPOTENCY_POLL_MS);
  }

  throw new AppError(
    'PAYMENT_ALREADY_PROCESSED',
    'This request is already processing',
    409,
    true,
  );
}

export async function allocateReceiptNumber(session: ClientSession, date: Date) {
  const year = businessYear(date);
  const counter = await ReceiptCounter.findOneAndUpdate(
    { scope: `PAYMENT-${year}` },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session, setDefaultsOnInsert: true },
  );
  return formatReceiptNumber(year, counter.value);
}

export async function createManualPayment(
  input: ManualPaymentInput,
  context: AuditContext & { actorId: string; actorRole: 'ADMIN' | 'STAFF' },
) {
  paise(input.amountPaise);
  const claim = await claimOrLoadManualIdempotency(
    context.actorId,
    input.idempotencyKey,
    input,
  );
  if (claim.kind === 'completed') return claim.response;

  try {
    return await withMongoTransaction(async (session) => {
      await assertDateInOpenPeriod(input.paymentDate, session);
      const lockOwner = `manual-payment:${context.requestId ?? randomUUID()}`;
      await claimEnrollmentSettlementLock(
        input.schemeId,
        lockOwner,
        session,
        SETTLEMENT_LOCK_PAYMENT_STATUSES,
      );
      const customer = await Customer.findById(input.customerId).session(session);
      if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
      await assertCustomerCanStartFinancialActivity(String(customer._id), session);
      const successPayout = await Payout.findOne({
        schemeId: input.schemeId,
        status: 'SUCCESS',
      }).session(session);
      if (successPayout) {
        throw new AppError('SCHEME_ALREADY_SETTLED', 'Scheme is already settled', 409);
      }
      const { schemeMonth: requestedSchemeMonth, ...paymentFields } = input;
      const rules = await getPaymentRules(
        input.schemeId,
        input.paymentDate,
        input.amountPaise,
        session,
        { targetSchemeMonth: requestedSchemeMonth },
      );
      if (String(rules.enrollment.customerId) !== input.customerId)
        throw new AppError(
          'SCHEME_OWNERSHIP_MISMATCH',
          'Scheme does not belong to this customer',
          403,
        );
      let gold: any = {};
      if (rules.enrollment.schemeType === 'GOLD_WEIGHT') {
        const rate = await activeGoldRate(input.paymentDate, session);
        gold = {
          goldRateId: rate._id,
          goldRatePerGramPaise: rate.ratePerGramPaise,
          goldPurity: rate.purity,
          goldWeightMg: goldWeightMg(input.amountPaise, rate.ratePerGramPaise),
        };
        await GoldRate.updateOne({ _id: rate._id }, { $inc: { usageCount: 1 } }, { session });
      }
      const receipt = await allocateReceiptNumber(session, input.paymentDate);
      const recognizedAt = new Date();
      const [payment] = await Payment.create(
        [
          {
            ...paymentFields,
            status: 'SUCCESS',
            schemeMonth: rules.schemeMonth,
            receiptNumber: receipt,
            collectedBy: context.actorId,
            collectorRole: context.actorRole,
            createdBy: context.actorId,
            recognizedAt,
            accountingDate: input.paymentDate,
            ...gold,
          },
        ],
        { session },
      );
      await syncEnrollmentFromLedger(String(rules.enrollment._id), session, rules.enrollment.__v);
      await audit(
        session,
        context,
        'PAYMENT_CREATED',
        'Payment',
        payment._id,
        undefined,
        payment.toObject(),
      );
      await outbox(session, 'PAYMENT_RECEIPT_READY', 'Payment', payment._id, {
        paymentId: payment._id,
        customerId: customer._id,
        receiptNumber: receipt,
      });
      const response = {
        paymentId: payment._id,
        receiptNumber: receipt,
        amountPaise: input.amountPaise,
        method: input.method,
        paymentDate: input.paymentDate,
        status: 'SUCCESS',
        schemeMonth: rules.schemeMonth,
        contribution: await buildContributionStatus(String(rules.enrollment._id)),
        ...gold,
      };
      await IdempotencyRecord.updateOne(
        { _id: claim.record._id },
        {
          $set: {
            state: 'COMPLETED',
            responseStatus: 201,
            responseBody: response,
            processingLockedAt: null,
            processingLockUntil: null,
          },
        },
        { session },
      );
      await clearEnrollmentSettlementLock(input.schemeId, lockOwner, session);
      return response;
    }, context.requestId);
  } catch (error) {
    // Release claim so a safe retry can re-attempt after a true failure.
    await IdempotencyRecord.deleteOne({
      _id: claim.record._id,
      state: 'PROCESSING',
    }).catch(() => undefined);
    throw error;
  }
}

export function gatewayGoldFromIntent(
  intent: {
    goldRateId?: unknown;
    goldRatePerGramPaise?: number | null;
    goldWeightMg?: number | null;
    goldPurity?: string | null;
  },
  schemeType: string,
) {
  if (schemeType !== 'GOLD_WEIGHT') return {};
  if (
    !intent.goldRateId ||
    intent.goldRatePerGramPaise == null ||
    intent.goldWeightMg == null
  ) {
    throw new AppError(
      'PAYMENT_QUOTE_INCOMPLETE',
      'Payment intent is missing the locked gold quote',
      409,
    );
  }
  return {
    goldRateId: intent.goldRateId,
    goldRatePerGramPaise: intent.goldRatePerGramPaise,
    goldPurity: intent.goldPurity,
    goldWeightMg: intent.goldWeightMg,
  };
}

async function finalizeGatewayPaymentWork(
  session: ClientSession,
  intent: any,
  provider: { transactionId?: string; amountPaise: number; providerCompletedAt?: Date },
  context: AuditContext,
) {
  const existing = await Payment.findOne({
    merchantTransactionId: intent.merchantTransactionId,
  }).session(session);
  if (existing) {
    // Keep intent aligned when a prior attempt already created the payment.
    await PaymentIntent.updateOne(
      mongoose.trusted({ _id: intent._id, status: mongoose.trusted({ $ne: 'SUCCESS' }) }),
      { $set: { status: 'SUCCESS' }, $unset: { activeAttemptKey: '' } },
      { session },
    );
    intent.status = 'SUCCESS';
    return existing;
  }
  if (provider.amountPaise !== intent.amountPaise)
    throw new AppError(
      'GATEWAY_AMOUNT_MISMATCH',
      'Gateway amount does not match payment intent',
      409,
    );
  const receivedAt = new Date();
  const timestamps = await resolveGatewayAccountingDate(
    provider.providerCompletedAt,
    receivedAt,
    session,
  );
  const targetSchemeMonth =
    intent.schemeMonth ??
    (await resolveTargetSchemeMonth(
      String(intent.schemeId),
      undefined,
      session,
      timestamps.paymentDate,
    ));
  const rules = await getPaymentRules(
    String(intent.schemeId),
    timestamps.paymentDate,
    intent.amountPaise,
    session,
    { targetSchemeMonth, requireGoldRate: false },
  );
  const gold = gatewayGoldFromIntent(intent, rules.enrollment.schemeType);
  if (gold.goldRateId) {
    await GoldRate.updateOne({ _id: gold.goldRateId }, { $inc: { usageCount: 1 } }, { session });
  }
  const receipt = await allocateReceiptNumber(session, receivedAt);
  const [payment] = await Payment.create(
    [
      {
        customerId: intent.customerId,
        schemeId: intent.schemeId,
        amountPaise: intent.amountPaise,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: timestamps.paymentDate,
        accountingDate: timestamps.accountingDate,
        schemeMonth: rules.schemeMonth,
        receiptNumber: receipt,
        merchantTransactionId: intent.merchantTransactionId,
        providerTransactionId: provider.transactionId,
        collectedBy: intent.collectedBy,
        collectorRole: intent.collectorRole ?? 'CUSTOMER',
        createdBy: intent.createdBy,
        recognizedAt: receivedAt,
        ...(provider.providerCompletedAt ? { providerCompletedAt: provider.providerCompletedAt } : {}),
        ...gold,
      },
    ],
    { session },
  );
  await syncEnrollmentFromLedger(String(rules.enrollment._id), session, rules.enrollment.__v);

  // Reload inside the txn so OCC version matches DB (caller may hold a stale doc,
  // especially after a prior aborted transaction attempt bumped in-memory __v).
  const activeIntent = await PaymentIntent.findById(intent._id).session(session);
  if (!activeIntent) {
    throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
  }
  if (activeIntent.status !== 'SUCCESS') {
    activeIntent.status = 'SUCCESS';
    activeIntent.activeAttemptKey = undefined;
    await activeIntent.save({ session });
  }
  intent.status = 'SUCCESS';
  intent.__v = activeIntent.__v;

  await audit(
    session,
    context,
    'PHONEPE_PAYMENT_FINALIZED',
    'Payment',
    payment._id,
    undefined,
    payment.toObject(),
  );
  await outbox(session, 'PAYMENT_RECEIPT_READY', 'Payment', payment._id, {
    paymentId: payment._id,
    customerId: intent.customerId,
    receiptNumber: receipt,
  });
  return payment;
}

async function reportLateGatewayAccountingIfNeeded(payment: {
  _id: unknown;
  customerId?: unknown;
  schemeId?: unknown;
  amountPaise?: number;
  merchantTransactionId?: string;
  providerCompletedAt?: Date;
  recognizedAt?: Date;
  accountingDate?: Date;
  paymentDate?: Date;
}) {
  if (!payment.providerCompletedAt || !payment.accountingDate) return;
  if (toPeriodKey(payment.providerCompletedAt) === toPeriodKey(payment.accountingDate)) return;
  await upsertFinancialException({
    dedupeKey: `payment:${payment._id}:LATE_GATEWAY_PAYMENT_AFTER_PERIOD_CLOSE`,
    type: 'LATE_GATEWAY_PAYMENT_AFTER_PERIOD_CLOSE',
    title: 'Gateway payment recognized after accounting period close',
    description:
      'PhonePe completed this payment in a now-closed period; customer credit was applied using the open recognition period',
    sourceType: 'Payment',
    sourceId: payment._id,
    paymentId: payment._id,
    customerId: payment.customerId,
    schemeId: payment.schemeId,
    amountPaise: payment.amountPaise,
    providerReference: payment.merchantTransactionId,
    metadata: {
      providerPeriodKey: toPeriodKey(payment.providerCompletedAt),
      recognitionPeriodKey: toPeriodKey(payment.recognizedAt ?? payment.accountingDate),
      providerCompletedAt: payment.providerCompletedAt,
      recognizedAt: payment.recognizedAt,
      accountingDate: payment.accountingDate,
      paymentDate: payment.paymentDate,
    },
  });
}

export async function finalizeGatewayPayment(
  intent: any,
  provider: { transactionId?: string; amountPaise: number; providerCompletedAt?: Date },
  context: AuditContext,
  session?: ClientSession,
) {
  const payment = session
    ? await finalizeGatewayPaymentWork(session, intent, provider, context)
    : await withMongoTransaction(
        (activeSession) => finalizeGatewayPaymentWork(activeSession, intent, provider, context),
        context.requestId,
      );
  try {
    await reportLateGatewayAccountingIfNeeded(payment);
  } catch (error) {
    logger.error(
      { err: error, paymentId: payment._id },
      'failed to record late gateway accounting exception',
    );
  }
  return payment;
}
