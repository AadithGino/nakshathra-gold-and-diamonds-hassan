import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import {
  Payment,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
} from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { sha256Canonical } from '../utils/canonical-hash.js';
import {
  buildCursorPage,
  buildOffsetPage,
  coerceBoundedListQuery,
  cursorFetchLimit,
  offsetSkip,
  type ListPageResult,
  type ListQuery,
  withKeysetFilter,
} from '../utils/cursor-pagination.js';
import { withMongoTransaction } from '../utils/transaction.js';
import {
  claimEnrollmentSettlementLock,
  clearEnrollmentSettlementLock,
  SETTLEMENT_LOCK_REFUND_STATUSES,
  syncEnrollmentFromLedger,
} from '../utils/enrollment-ledger.js';
import {
  isRefundPendingTooLong,
  nextRefundRecoveryCheckAt,
  scheduleInitialRefundStatusCheck,
} from '../utils/refund-recovery.js';
import { audit, outbox, type AuditContext } from './audit.service.js';
import {
  reportBlockedRefundException,
  reportRefundException,
} from './financial-exception.service.js';
import type { GatewayRefundStatus } from './payment-gateway.js';
import { phonePeProvider } from './phonepe.provider.js';
import { logger } from '../config/logger.js';

const BLOCKED_SCHEME_STATUSES = new Set(['REDEEMED', 'CLOSED', 'WITHDRAWN']);

function refundRequestHash(paymentId: string, amountPaise: number, reason: string) {
  return sha256Canonical({ paymentId, amountPaise, reason });
}

function appendStatusHistory(
  refund: { statusHistory?: Array<{ status: string; at: Date; source: string; note?: string }> },
  status: string,
  source: string,
  note?: string,
) {
  if (!refund.statusHistory) refund.statusHistory = [];
  refund.statusHistory.push({ status, at: new Date(), source, note });
}

function storeProviderFields(refund: any, provider: GatewayRefundStatus) {
  refund.lastProviderResponse = provider.raw;
  if (provider.providerRefundId) refund.providerRefundId = provider.providerRefundId;
  // Only store a real bank/rail reference — never treat provider refund id as bank UTR.
  if (provider.bankReferenceId) refund.providerBankReferenceId = provider.bankReferenceId;
  if (provider.railType) refund.providerRailType = provider.railType;
  if (provider.errorCode) refund.providerErrorCode = provider.errorCode;
  if (provider.detailedErrorCode) refund.providerDetailedErrorCode = provider.detailedErrorCode;
}

function refundStartedAt(refund: { requestedAt?: Date; createdAt?: Date }) {
  return refund.requestedAt ?? refund.createdAt ?? new Date();
}

function refundResponse(refund: any) {
  return {
    refundId: refund._id,
    paymentId: refund.paymentId,
    merchantRefundId: refund.merchantRefundId,
    amountPaise: refund.amountPaise,
    status: refund.status,
    attemptNumber: refund.attemptNumber ?? 1,
    active: refund.active !== false,
    reason: refund.reason,
    requestedAt: refund.requestedAt,
    providerRefundId: refund.providerRefundId ?? null,
    nextStatusCheckAt: refund.nextStatusCheckAt ?? null,
  };
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

function deactivateTerminalRefund(refund: {
  active?: boolean;
  status?: string;
}) {
  refund.active = false;
}

async function assertRefundEligibility(
  payment: any,
  session: ClientSession,
  lockOwner?: string,
) {
  if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
  if (payment.status !== 'SUCCESS') {
    throw new AppError(
      'PAYMENT_NOT_REFUNDABLE',
      `Payment status ${payment.status} cannot be refunded`,
      409,
    );
  }
  if (!payment.merchantTransactionId) {
    throw new AppError(
      'REFUND_NOT_GATEWAY_PAYMENT',
      'Only PhonePe/gateway payments with a merchant transaction id can be refunded',
      409,
    );
  }

  const intent = await PaymentIntent.findOne({
    merchantTransactionId: payment.merchantTransactionId,
  }).session(session);
  if (!payment.providerTransactionId && !intent) {
    throw new AppError(
      'REFUND_NOT_GATEWAY_PAYMENT',
      'Payment is missing gateway identifiers required for refund',
      409,
    );
  }

  const blocking = await Refund.findOne(
    mongoose.trusted({
      paymentId: payment._id,
      $or: [
        { active: true },
        {
          status: mongoose.trusted({ $in: ['SUCCESS', 'REVIEW_REQUIRED'] }),
        },
      ],
    }),
  ).session(session);
  if (blocking) {
    throw new AppError(
      blocking.status === 'REVIEW_REQUIRED'
        ? 'REFUND_REVIEW_REQUIRED'
        : 'REFUND_ALREADY_EXISTS',
      blocking.status === 'REVIEW_REQUIRED'
        ? 'Refund requires manual review before another attempt'
        : 'A refund already exists for this payment',
      409,
      false,
      [{ refundId: blocking._id, status: blocking.status, active: blocking.active }],
    );
  }

  const enrollment = await SchemeEnrollment.findById(payment.schemeId).session(session);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Scheme enrollment not found', 404);
  if (BLOCKED_SCHEME_STATUSES.has(enrollment.status)) {
    try {
      await reportBlockedRefundException(
        payment,
        'Refund is blocked because the scheme has been redeemed or closed',
      );
    } catch (error) {
      logger.error({ err: error, paymentId: payment._id }, 'failed to record blocked refund exception');
    }
    throw new AppError(
      'REFUND_BLOCKED_AFTER_REDEMPTION',
      'Refund is blocked because the scheme has been redeemed or closed',
      409,
    );
  }

  const payout = await Payout.findOne({
    schemeId: payment.schemeId,
    status: 'SUCCESS',
  }).session(session);
  if (payout) {
    try {
      await reportBlockedRefundException(
        payment,
        'Refund is blocked because a successful payout exists for this scheme',
      );
    } catch (error) {
      logger.error({ err: error, paymentId: payment._id }, 'failed to record blocked refund exception');
    }
    throw new AppError(
      'REFUND_BLOCKED_AFTER_REDEMPTION',
      'Refund is blocked because a successful payout exists for this scheme',
      409,
    );
  }

  if (lockOwner) {
    await claimEnrollmentSettlementLock(
      payment.schemeId,
      lockOwner,
      session,
      SETTLEMENT_LOCK_REFUND_STATUSES,
    );
  }

  return { enrollment, intent };
}

async function resolveIdempotentRefundRetry(
  paymentId: string,
  input: { reason: string; idempotencyKey: string },
  context: { actorId: string },
) {
  const existingByKey = await Refund.findOne({
    requestedBy: context.actorId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingByKey) {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    const incomingHash = refundRequestHash(paymentId, payment.amountPaise, input.reason.trim());
    if (
      String(existingByKey.paymentId) !== paymentId ||
      existingByKey.requestHash !== incomingHash
    ) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was reused with different payment data',
        409,
      );
    }
    return existingByKey;
  }

  const active = await Refund.findOne({ paymentId, active: true });
  if (active) {
    throw new AppError(
      'REFUND_ALREADY_EXISTS',
      'A refund already exists for this payment',
      409,
      false,
      [{ refundId: active._id, status: active.status }],
    );
  }

  throw new AppError(
    'REFUND_CREATE_RACE',
    'Refund create raced; retry the request',
    409,
    true,
  );
}

export async function initiatePaymentRefund(
  paymentId: string,
  input: { reason: string; idempotencyKey: string; amountPaise?: number },
  context: AuditContext & { actorId: string },
) {
  const reason = input.reason.trim();
  if (!reason) throw new AppError('VALIDATION_ERROR', 'Refund reason is required', 422);

  let prepared: {
    refund: any;
    alreadyExisted: boolean;
    originalMerchantOrderId?: string;
    amountPaise?: number;
    originalAmountPaise?: number;
    originalGoldWeightMg?: number;
    originalGoldRate?: number;
  };

  try {
    // Transaction A — create local refund record without holding a PhonePe call.
    prepared = await withMongoTransaction(async (session) => {
      const existingByKey = await Refund.findOne({
        requestedBy: context.actorId,
        idempotencyKey: input.idempotencyKey,
      }).session(session);
      if (existingByKey) {
        const payment = await Payment.findById(paymentId).session(session);
        if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
        const incomingHash = refundRequestHash(paymentId, payment.amountPaise, reason);
        if (
          String(existingByKey.paymentId) !== paymentId ||
          existingByKey.requestHash !== incomingHash
        ) {
          throw new AppError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency key was reused with different payment data',
            409,
          );
        }
        return { refund: existingByKey, alreadyExisted: true as const };
      }

      const payment = await Payment.findById(paymentId).session(session);
      const lockOwner = `refund:${context.actorId}:${input.idempotencyKey}`;
      const { intent } = await assertRefundEligibility(payment, session, lockOwner);

      if (input.amountPaise != null && input.amountPaise !== payment.amountPaise) {
        throw new AppError(
          'PARTIAL_REFUND_NOT_SUPPORTED',
          'Only full refunds are supported',
          422,
        );
      }

      const lastAttempt = await Refund.findOne({ paymentId: payment._id })
        .sort({ attemptNumber: -1 })
        .select('attemptNumber')
        .session(session)
        .lean();
      const attemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

      const requestHash = refundRequestHash(String(payment._id), payment.amountPaise, reason);
      const merchantRefundId = `RFD-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const requestedAt = new Date();
      // Schedule recovery BEFORE PhonePe so a crash after provider accept is still recoverable.
      const nextStatusCheckAt = scheduleInitialRefundStatusCheck(requestedAt);
      const [refund] = await Refund.create(
        [
          {
            paymentId: payment._id,
            paymentIntentId: intent?._id,
            customerId: payment.customerId,
            schemeId: payment.schemeId,
            provider: 'PHONEPE',
            merchantRefundId,
            originalMerchantOrderId: payment.merchantTransactionId,
            amountPaise: payment.amountPaise,
            status: 'INITIATED',
            attemptNumber,
            active: true,
            reason,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            requestedBy: context.actorId,
            requestedAt,
            nextStatusCheckAt,
            statusCheckAttempts: 0,
            recoveryLockedAt: null,
            recoveryLockUntil: null,
            recoveryLockedBy: null,
            statusHistory: [
              { status: 'INITIATED', at: requestedAt, source: 'ADMIN', note: reason },
            ],
          },
        ],
        { session },
      );

      payment.refundId = refund._id;
      payment.refundStatus = 'PENDING';
      payment.refundRequestedAt = requestedAt;
      payment.updatedBy = context.actorId;
      await payment.save({ session });
      await clearEnrollmentSettlementLock(payment.schemeId, lockOwner, session);

      await audit(session, context, 'REFUND_REQUESTED', 'Refund', refund._id, undefined, {
        paymentId: payment._id,
        merchantRefundId,
        amountPaise: payment.amountPaise,
        reason,
        attemptNumber,
      });

      return {
        refund,
        alreadyExisted: false as const,
        originalMerchantOrderId: String(payment.merchantTransactionId),
        amountPaise: payment.amountPaise as number,
        originalAmountPaise: payment.amountPaise as number,
        originalGoldWeightMg: payment.goldWeightMg as number | undefined,
        originalGoldRate: payment.goldRatePerGramPaise as number | undefined,
      };
    }, context.requestId);
  } catch (error) {
    // Duplicate-key races must be resolved outside the aborted transaction.
    if (!isDuplicateKeyError(error)) throw error;
    const recovered = await resolveIdempotentRefundRetry(paymentId, { reason, idempotencyKey: input.idempotencyKey }, context);
    return refundResponse(recovered);
  }

  if (prepared.alreadyExisted) {
    return refundResponse(prepared.refund);
  }

  // PhonePe call outside the Mongo transaction.
  let providerStatus: GatewayRefundStatus | undefined;
  let providerError: unknown;
  try {
    providerStatus = await phonePeProvider.initiateRefund({
      merchantRefundId: prepared.refund.merchantRefundId,
      originalMerchantOrderId: prepared.originalMerchantOrderId!,
      amountPaise: prepared.amountPaise!,
    });
  } catch (error) {
    providerError = error;
    logger.error(
      { err: error, merchantRefundId: prepared.refund.merchantRefundId },
      'PhonePe refund initiation uncertain; scheduling status recovery',
    );
  }

  // Transaction B — record provider response / schedule recovery / finalize on success.
  if (providerStatus?.state === 'SUCCESS') {
    const finalized = await finalizeSuccessfulRefund(
      String(prepared.refund._id),
      providerStatus,
      context,
    );
    const paymentAfter = await Payment.findById(paymentId).lean();
    if (
      paymentAfter &&
      (paymentAfter.amountPaise !== prepared.originalAmountPaise ||
        paymentAfter.goldWeightMg !== prepared.originalGoldWeightMg ||
        paymentAfter.goldRatePerGramPaise !== prepared.originalGoldRate)
    ) {
      throw new AppError(
        'LEDGER_INTEGRITY_ERROR',
        'Refund finalization mutated immutable payment financial fields',
        500,
        true,
      );
    }
    return refundResponse(finalized);
  }

  const finalized = await withMongoTransaction(async (session) => {
    const refund = await Refund.findById(prepared.refund._id).session(session);
    if (!refund) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
    if (
      refund.status === 'SUCCESS' ||
      refund.status === 'FAILED' ||
      refund.status === 'REVIEW_REQUIRED'
    ) {
      return refund;
    }

    if (providerStatus?.state === 'FAILED') {
      storeProviderFields(refund, providerStatus);
      refund.status = 'FAILED';
      deactivateTerminalRefund(refund);
      refund.failedAt = new Date();
      refund.confirmedAt = new Date();
      refund.providerInitiatedAt = refund.providerInitiatedAt ?? new Date();
      refund.providerErrorCode = providerStatus.errorCode ?? refund.providerErrorCode;
      refund.providerErrorMessage =
        providerStatus.detailedErrorCode ??
        providerStatus.errorCode ??
        'Provider failed refund';
      refund.nextStatusCheckAt = undefined;
      refund.recoveryLockedAt = undefined;
      refund.recoveryLockUntil = undefined;
      refund.recoveryLockedBy = undefined;
      appendStatusHistory(
        refund,
        'FAILED',
        'PHONEPE_INITIATE',
        providerStatus.errorCode ?? 'Provider failed refund',
      );
      await refund.save({ session });
      await Payment.updateOne(
        { _id: refund.paymentId },
        { $set: { refundStatus: 'FAILED', updatedBy: context.actorId } },
        { session },
      );
    } else if (providerStatus) {
      // PhonePe accepted initiation (pending confirmation).
      storeProviderFields(refund, providerStatus);
      refund.status = 'PENDING';
      refund.providerInitiatedAt = new Date();
      refund.nextStatusCheckAt = nextRefundRecoveryCheckAt(refundStartedAt(refund));
      appendStatusHistory(refund, 'PENDING', 'PHONEPE_INITIATE', 'Awaiting provider confirmation');
      await refund.save({ session });
    } else {
      // Uncertain network/result — keep INITIATED, do not invent providerInitiatedAt.
      refund.status = 'INITIATED';
      refund.active = true;
      refund.lastProviderError = String(
        (providerError as { message?: string })?.message ?? providerError ?? 'uncertain',
      ).slice(0, 500);
      refund.nextStatusCheckAt = nextRefundRecoveryCheckAt(refundStartedAt(refund));
      appendStatusHistory(
        refund,
        'INITIATED',
        'PHONEPE_INITIATE',
        refund.lastProviderError,
      );
      refund.lastProviderResponse = {
        uncertain: true,
        message: refund.lastProviderError,
      };
      await refund.save({ session });
    }

    await audit(session, context, 'REFUND_PROVIDER_UPDATED', 'Refund', refund._id, undefined, {
      status: refund.status,
      merchantRefundId: refund.merchantRefundId,
      providerRefundId: refund.providerRefundId,
    });

    return refund;
  }, context.requestId);

  const paymentAfter = await Payment.findById(paymentId).lean();
  if (
    paymentAfter &&
    (paymentAfter.amountPaise !== prepared.originalAmountPaise ||
      paymentAfter.goldWeightMg !== prepared.originalGoldWeightMg ||
      paymentAfter.goldRatePerGramPaise !== prepared.originalGoldRate ||
      paymentAfter.status !== 'SUCCESS')
  ) {
    throw new AppError(
      'LEDGER_INTEGRITY_ERROR',
      'Refund initiation mutated immutable payment financial fields',
      500,
      true,
    );
  }

  if (finalized.status === 'FAILED') {
    void reportRefundException(
      finalized,
      'REFUND_FAILED',
      finalized.providerErrorCode ?? 'Provider failed refund',
    );
  }

  return refundResponse(finalized);
}

/**
 * Controlled retry of a terminal FAILED refund attempt.
 * Preserves the failed document and creates a new attempt with a fresh merchant refund id.
 */
export async function retryFailedRefund(
  failedRefundId: string,
  input: { idempotencyKey: string; reason?: string; amountPaise?: number },
  context: AuditContext & { actorId: string },
) {
  const failed = await Refund.findById(failedRefundId);
  if (!failed) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
  if (failed.status !== 'FAILED') {
    throw new AppError(
      'REFUND_NOT_RETRYABLE',
      `Only FAILED refunds can be retried (current status: ${failed.status})`,
      409,
      false,
      [{ refundId: failed._id, status: failed.status }],
    );
  }
  if (failed.active) {
    // Defensive: terminal FAILED should already be inactive.
    failed.active = false;
    await failed.save();
  }

  const payment = await Payment.findById(failed.paymentId);
  if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
  if (payment.status !== 'SUCCESS') {
    throw new AppError(
      'PAYMENT_NOT_REFUNDABLE',
      `Payment status ${payment.status} cannot be refunded`,
      409,
    );
  }

  return initiatePaymentRefund(
    String(failed.paymentId),
    {
      reason: (input.reason ?? failed.reason).trim(),
      idempotencyKey: input.idempotencyKey,
      amountPaise: input.amountPaise,
    },
    context,
  );
}

/**
 * Confirm a PhonePe refund success and mark the payment REFUNDED.
 * Idempotent — safe under worker / manual race.
 */
type FinalizeRefundResult =
  | { refund: any; conflict?: undefined }
  | {
      refund: any;
      conflict: 'REFUND_COMPLETED_AFTER_REDEMPTION';
      schemeStatus: string;
    };

export async function finalizeSuccessfulRefund(
  refundId: string,
  providerStatus: GatewayRefundStatus,
  context: AuditContext,
  outerSession?: ClientSession,
) {
  const work = async (session: ClientSession): Promise<FinalizeRefundResult> => {
    const refund = await Refund.findById(refundId).session(session);
    if (!refund) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
    if (refund.status === 'SUCCESS') return { refund };
    if (refund.status === 'REVIEW_REQUIRED') {
      return {
        refund,
        conflict: 'REFUND_COMPLETED_AFTER_REDEMPTION',
        schemeStatus: 'UNKNOWN',
      };
    }

    const payment = await Payment.findById(refund.paymentId).session(session);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);

    if (providerStatus.amountPaise !== refund.amountPaise) {
      throw new AppError(
        'GATEWAY_AMOUNT_MISMATCH',
        'Provider refund amount does not match refund record',
        409,
      );
    }
    if (providerStatus.amountPaise !== payment.amountPaise) {
      throw new AppError(
        'GATEWAY_AMOUNT_MISMATCH',
        'Provider refund amount does not match payment amount',
        409,
      );
    }
    if (refund.originalMerchantOrderId !== payment.merchantTransactionId) {
      throw new AppError(
        'GATEWAY_VERIFICATION_FAILED',
        'Refund merchant order does not match payment',
        409,
      );
    }
    if (payment.status === 'REVERSED') {
      throw new AppError('PAYMENT_NOT_REFUNDABLE', 'Reversed payments cannot be refunded', 409);
    }
    if (
      payment.refundId &&
      String(payment.refundId) !== String(refund._id) &&
      payment.refundStatus === 'SUCCESS'
    ) {
      throw new AppError(
        'REFUND_ALREADY_EXISTS',
        'Payment is already linked to another successful refund',
        409,
      );
    }

    // Re-validate redemption interlock inside the success transaction. If PhonePe
    // already paid out the refund after local redemption, commit a terminal review
    // state with provider proof — never leave PENDING (recovery would loop).
    const enrollment = await SchemeEnrollment.findById(payment.schemeId).session(session);
    if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Scheme enrollment not found', 404);
    const successfulPayout = await Payout.findOne({
      schemeId: payment.schemeId,
      status: 'SUCCESS',
    }).session(session);
    if (BLOCKED_SCHEME_STATUSES.has(enrollment.status) || successfulPayout) {
      const now = new Date();
      storeProviderFields(refund, providerStatus);
      refund.status = 'REVIEW_REQUIRED';
      deactivateTerminalRefund(refund);
      refund.completedAt = now;
      refund.confirmedAt = now;
      refund.providerInitiatedAt = refund.providerInitiatedAt ?? now;
      refund.nextStatusCheckAt = undefined;
      refund.recoveryLockedAt = undefined;
      refund.recoveryLockUntil = undefined;
      refund.recoveryLockedBy = undefined;
      refund.lastProviderResponse = {
        ...(typeof refund.lastProviderResponse === 'object' && refund.lastProviderResponse
          ? refund.lastProviderResponse
          : {}),
        conflict: 'REFUND_COMPLETED_AFTER_REDEMPTION',
        providerStatus,
      };
      appendStatusHistory(
        refund,
        'REVIEW_REQUIRED',
        'FINALIZE',
        'Provider success after redemption — manual resolution required',
      );
      await refund.save({ session });

      // Keep payment SUCCESS / amounts / gold unchanged; surface review on refundStatus.
      payment.refundStatus = 'REVIEW_REQUIRED';
      payment.refundId = refund._id;
      if (context.actorId) payment.updatedBy = context.actorId;
      await payment.save({ session });

      await reportRefundException(
        refund,
        'REFUND_COMPLETED_AFTER_REDEMPTION',
        'Provider completed refund after scheme redemption/payout; ledger was not mutated',
        {
          schemeStatus: enrollment.status,
          payoutId: successfulPayout?._id,
          providerRefundId: providerStatus.providerRefundId,
          providerBankReferenceId: providerStatus.bankReferenceId,
        },
      );
      return {
        refund,
        conflict: 'REFUND_COMPLETED_AFTER_REDEMPTION',
        schemeStatus: enrollment.status,
      };
    }

    const now = new Date();
    storeProviderFields(refund, providerStatus);
    refund.status = 'SUCCESS';
    deactivateTerminalRefund(refund);
    refund.completedAt = now;
    refund.confirmedAt = now;
    refund.providerInitiatedAt = refund.providerInitiatedAt ?? now;
    refund.nextStatusCheckAt = undefined;
    refund.recoveryLockedAt = undefined;
    refund.recoveryLockUntil = undefined;
    refund.recoveryLockedBy = undefined;
    appendStatusHistory(refund, 'SUCCESS', 'FINALIZE', 'Provider confirmed refund');
    await refund.save({ session });

    const immutable = {
      amountPaise: payment.amountPaise,
      goldWeightMg: payment.goldWeightMg,
      goldRatePerGramPaise: payment.goldRatePerGramPaise,
      goldRateId: payment.goldRateId,
      paymentDate: payment.paymentDate,
      receiptNumber: payment.receiptNumber,
    };

    payment.status = 'REFUNDED';
    payment.refundStatus = 'SUCCESS';
    payment.refundId = refund._id;
    payment.refundedAt = now;
    if (context.actorId) payment.updatedBy = context.actorId;
    await payment.save({ session });

    if (
      payment.amountPaise !== immutable.amountPaise ||
      payment.goldWeightMg !== immutable.goldWeightMg ||
      payment.goldRatePerGramPaise !== immutable.goldRatePerGramPaise ||
      String(payment.goldRateId ?? '') !== String(immutable.goldRateId ?? '') ||
      payment.receiptNumber !== immutable.receiptNumber
    ) {
      throw new AppError(
        'LEDGER_INTEGRITY_ERROR',
        'Refund finalization attempted to mutate immutable payment fields',
        500,
        true,
      );
    }

    await syncEnrollmentFromLedger(String(payment.schemeId), session);

    await audit(session, context, 'REFUND_COMPLETED', 'Refund', refund._id, undefined, {
      paymentId: payment._id,
      amountPaise: refund.amountPaise,
      merchantRefundId: refund.merchantRefundId,
      providerRefundId: refund.providerRefundId,
      providerBankReferenceId: refund.providerBankReferenceId,
    });
    await audit(session, context, 'PAYMENT_MARKED_REFUNDED', 'Payment', payment._id, undefined, {
      refundId: refund._id,
      refundedAt: now,
    });
    await outbox(session, 'PAYMENT_REFUNDED', 'Payment', payment._id, {
      paymentId: payment._id,
      refundId: refund._id,
      customerId: payment.customerId,
      amountPaise: payment.amountPaise,
      receiptNumber: payment.receiptNumber,
    });

    return { refund };
  };

  const result = outerSession
    ? await work(outerSession)
    : await withMongoTransaction(work, context.requestId ?? 'refund-finalize');

  // Conflict evidence is committed above; surface 409 only after the transaction succeeds.
  if (result.conflict) {
    throw new AppError(
      'REFUND_COMPLETED_AFTER_REDEMPTION',
      'Provider completed refund after redemption; manual resolution required',
      409,
      false,
      [{ refundId: result.refund._id, schemeStatus: result.schemeStatus }],
    );
  }
  return result.refund;
}

/**
 * Terminal FAILED refunds are not auto-retried against PhonePe.
 * Ops must use POST /admin/refunds/:failedRefundId/retry with a new idempotency key.
 */
export async function markFailedRefund(
  refundId: string,
  providerStatus: GatewayRefundStatus,
  context: AuditContext,
) {
  return withMongoTransaction(async (session) => {
    const refund = await Refund.findById(refundId).session(session);
    if (!refund) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
    if (refund.status === 'SUCCESS') return refund;
    if (refund.status === 'FAILED') return refund;
    if (refund.status === 'REVIEW_REQUIRED') return refund;

    const now = new Date();
    storeProviderFields(refund, providerStatus);
    refund.status = 'FAILED';
    deactivateTerminalRefund(refund);
    refund.failedAt = now;
    refund.nextStatusCheckAt = undefined;
    refund.recoveryLockedAt = undefined;
    refund.recoveryLockUntil = undefined;
    refund.recoveryLockedBy = undefined;
    appendStatusHistory(
      refund,
      'FAILED',
      'RECOVERY',
      providerStatus.errorCode ?? 'Provider failed refund',
    );
    await refund.save({ session });

    await Payment.updateOne(
      { _id: refund.paymentId, status: 'SUCCESS' },
      {
        $set: {
          refundStatus: 'FAILED',
          refundId: refund._id,
          ...(context.actorId ? { updatedBy: context.actorId } : {}),
        },
      },
      { session },
    );

    await audit(session, context, 'REFUND_FAILED', 'Refund', refund._id, undefined, {
      paymentId: refund.paymentId,
      merchantRefundId: refund.merchantRefundId,
      errorCode: refund.providerErrorCode,
    });

    return refund;
  }, context.requestId ?? 'refund-fail').then(async (refund) => {
    void reportRefundException(
      refund,
      'REFUND_FAILED',
      refund.providerErrorCode ?? 'Provider failed refund',
    );
    return refund;
  });
}

/** Poll PhonePe for an app-created refund and finalize / fail / reschedule. */
export async function reconcileRefundStatus(
  refundId: string,
  context: AuditContext,
  prefetched?: GatewayRefundStatus,
) {
  const refund = await Refund.findById(refundId);
  if (!refund) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
  if (
    refund.status === 'SUCCESS' ||
    refund.status === 'FAILED' ||
    refund.status === 'REVIEW_REQUIRED'
  ) {
    return {
      state: refund.status as 'SUCCESS' | 'FAILED' | 'REVIEW_REQUIRED',
      skipped: true as const,
      refund,
    };
  }

  let providerStatus: GatewayRefundStatus;
  try {
    providerStatus =
      prefetched ?? (await phonePeProvider.checkRefundStatus(refund.merchantRefundId));
  } catch (error: unknown) {
    const now = new Date();
    refund.lastStatusCheckedAt = now;
    refund.statusCheckAttempts = (refund.statusCheckAttempts ?? 0) + 1;
    refund.lastProviderResponse = {
      transientError: true,
      message: String((error as { message?: string })?.message ?? error),
    };
    refund.nextStatusCheckAt = nextRefundRecoveryCheckAt(refundStartedAt(refund), now);
    await refund.save();
    void reportRefundException(
      refund,
      'REFUND_STATUS_CHECK_FAILED',
      String((error as { message?: string })?.message ?? error),
    );
    return { state: 'PENDING' as const, transientError: true as const, refund };
  }

  const now = new Date();
  refund.lastStatusCheckedAt = now;
  refund.statusCheckAttempts = (refund.statusCheckAttempts ?? 0) + 1;

  if (providerStatus.amountPaise !== refund.amountPaise) {
    refund.lastProviderResponse = {
      ...(typeof providerStatus.raw === 'object' && providerStatus.raw
        ? (providerStatus.raw as object)
        : { raw: providerStatus.raw }),
      marker: 'GATEWAY_AMOUNT_MISMATCH',
    };
    appendStatusHistory(
      refund,
      refund.status,
      'RECOVERY',
      'GATEWAY_AMOUNT_MISMATCH — not finalized',
    );
    refund.nextStatusCheckAt = new Date(now.getTime() + 30 * 60_000);
    await refund.save();
    logger.error(
      {
        merchantRefundId: refund.merchantRefundId,
        expected: refund.amountPaise,
        actual: providerStatus.amountPaise,
      },
      'Refund amount mismatch during recovery',
    );
    void reportRefundException(
      refund,
      'REFUND_AMOUNT_MISMATCH',
      'Provider refund amount does not match refund record',
    );
    return { state: 'PENDING' as const, amountMismatch: true as const, refund };
  }

  if (providerStatus.state === 'SUCCESS') {
    try {
      const finalized = await finalizeSuccessfulRefund(String(refund._id), providerStatus, context);
      return { state: 'SUCCESS' as const, refund: finalized };
    } catch (error) {
      // Conflict state is committed inside finalize; do not rethrow into recovery
      // (which would reschedule polling). Surface the terminal review status.
      if (
        error instanceof AppError &&
        error.code === 'REFUND_COMPLETED_AFTER_REDEMPTION'
      ) {
        const reviewed = await Refund.findById(refund._id);
        return {
          state: 'REVIEW_REQUIRED' as const,
          refund: reviewed ?? refund,
          conflict: true as const,
        };
      }
      throw error;
    }
  }

  if (providerStatus.state === 'FAILED') {
    const failed = await markFailedRefund(String(refund._id), providerStatus, context);
    return { state: 'FAILED' as const, refund: failed };
  }

  storeProviderFields(refund, providerStatus);
  refund.status = 'PENDING';
  if (isRefundPendingTooLong(refundStartedAt(refund), now)) {
    appendStatusHistory(refund, 'PENDING', 'RECOVERY', 'REFUND_PENDING_TOO_LONG');
    refund.lastProviderResponse = {
      ...(typeof providerStatus.raw === 'object' && providerStatus.raw
        ? (providerStatus.raw as object)
        : {}),
      marker: 'REFUND_PENDING_TOO_LONG',
    };
  } else {
    appendStatusHistory(refund, 'PENDING', 'RECOVERY', 'Still pending at provider');
  }
  refund.nextStatusCheckAt = nextRefundRecoveryCheckAt(refundStartedAt(refund), now);
  await refund.save();
  if (isRefundPendingTooLong(refundStartedAt(refund), now)) {
    void reportRefundException(refund, 'REFUND_PENDING_TOO_LONG');
  }
  return { state: 'PENDING' as const, refund };
}

export async function getRefundDetail(refundId: string) {
  const refund = await Refund.findById(refundId)
    .populate('paymentId')
    .populate('customerId')
    .populate('schemeId', 'enrollmentNumber status')
    .populate('requestedBy', 'name phone')
    .lean();
  if (!refund) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
  return refund;
}

export async function listRefunds(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'createdAt';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = Refund.find(filter)
    .populate('paymentId', 'receiptNumber amountPaise merchantTransactionId status refundStatus')
    .populate({ path: 'customerId', populate: { path: 'userId', select: 'name phone' } })
    .populate('schemeId', 'enrollmentNumber status')
    .populate('requestedBy', 'name phone');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.createdAt),
      (row) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    Refund.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}
