import { AppError } from '../utils/AppError.js';
import { randomUUID } from 'node:crypto';
import { withMongoTransaction } from '../utils/transaction.js';
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
import {
  aggregateEnrollmentLedger,
  assertEnrollmentSolvent,
  claimEnrollmentSettlementLock,
  clearEnrollmentSettlementLock,
  SETTLEMENT_LOCK_REDEMPTION_STATUSES,
  SETTLEMENT_LOCK_REFUND_STATUSES,
  syncEnrollmentFromLedger,
} from '../utils/enrollment-ledger.js';
import { paise } from '../utils/money.js';
import {
  CashSubmission,
  Customer,
  Payment,
  PaymentCorrection,
  Payout,
  Refund,
  SchemeEnrollment,
  StaffProfile,
} from '../models/index.js';
import { audit, outbox, type AuditContext } from './audit.service.js';
import mongoose from 'mongoose';
import { activeGoldRate, getPaymentRules, goldWeightMg } from './scheme.service.js';
import { allocateReceiptNumber } from './payment.service.js';
import { GoldRate } from '../models/index.js';
import {
  recordPayoutGoldIssue,
  reportNegativeInventoryException,
} from './gold-control.service.js';
import { assertDateInOpenPeriod } from './accounting-period.service.js';
import { assertCustomerKycVerified } from './customer-financial-policy.service.js';

function randomLockId() {
  return randomUUID().slice(0, 8);
}

const SETTLED_SCHEME_STATUSES = ['REDEEMED', 'CLOSED', 'WITHDRAWN'];
const ACTIVE_REFUND_STATUSES = ['INITIATED', 'PENDING', 'REVIEW_REQUIRED'];

/**
 * Shared interlock for any operation that mutates ledger-affecting Payment
 * state (manual reversal, correction approval) — refund initiation/
 * finalization, local reversal, correction approval, and redemption/payout
 * must not race each other on the same enrollment. Must be called after the
 * settlement lock is claimed and inside the same transaction as the
 * mutation, so the check-then-mutate window is atomic with respect to the
 * lock (not just the interlock query itself).
 */
async function assertNoBlockingSettlementActivity(schemeId: unknown, session: mongoose.ClientSession) {
  const enrollment = await SchemeEnrollment.findById(schemeId).session(session);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Scheme enrollment not found', 404);
  if (SETTLED_SCHEME_STATUSES.includes(enrollment.status)) {
    throw new AppError(
      'SETTLEMENT_BLOCKED_SCHEME_SETTLED',
      'This action is blocked because the scheme has already been redeemed or closed',
      409,
    );
  }
  const activeRefund = await Refund.findOne(
    mongoose.trusted({ schemeId, status: mongoose.trusted({ $in: ACTIVE_REFUND_STATUSES }) }),
  )
    .session(session)
    .select('_id status')
    .lean();
  if (activeRefund) {
    throw new AppError(
      'SETTLEMENT_BLOCKED_ACTIVE_REFUND',
      'This action is blocked while a refund is active for this scheme',
      409,
      false,
      [{ refundId: activeRefund._id, status: activeRefund.status }],
    );
  }
  const successfulPayout = await Payout.findOne({ schemeId, status: 'SUCCESS' })
    .session(session)
    .select('_id')
    .lean();
  if (successfulPayout) {
    throw new AppError(
      'SETTLEMENT_BLOCKED_PAYOUT_SETTLED',
      'This action is blocked because a successful payout already exists for this scheme',
      409,
    );
  }
  return enrollment;
}

/** Gateway-origin money (identified by a real gateway merchantTransactionId) must never be moved locally. */
function assertNotGatewayOrigin(payment: { merchantTransactionId?: string | null }) {
  if (payment.merchantTransactionId) {
    throw new AppError(
      'GATEWAY_PAYMENT_REQUIRES_REFUND',
      'Gateway payments must be returned through the PhonePe refund workflow.',
      409,
    );
  }
}

const paymentPopulates = (query: mongoose.Query<any, any>) =>
  query
    .populate({ path: 'customerId', populate: { path: 'userId', select: 'name phone' } })
    .populate({
      path: 'schemeId',
      select: 'enrollmentNumber schemeType',
      populate: { path: 'schemePlanId', select: 'name' },
    })
    .populate('collectedBy', 'name phone');

export async function listPayments(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'paymentDate';
  const filter = withKeysetFilter({}, query, sortField);

  if (query.mode === 'cursor') {
    const rows = (await paymentPopulates(Payment.find(filter))
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean()) as any[];
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row: any) => new Date(row.paymentDate),
      (row: any) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    paymentPopulates(Payment.find({}))
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean() as Promise<any[]>,
    Payment.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function getPaymentDetail(paymentId: string) {
  const payment = await Payment.findById(paymentId)
    .populate({ path: 'customerId', populate: { path: 'userId', select: 'name phone' } })
    .populate({
      path: 'schemeId',
      select: 'enrollmentNumber schemeType status',
      populate: { path: 'schemePlanId', select: 'name type' },
    })
    .populate('collectedBy', 'name phone')
    .populate('reversedBy', 'name')
    .lean();
  if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
  return payment;
}

function staffUserKey(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (typeof value === 'object' && value !== null && '_id' in value) {
    return staffUserKey((value as { _id: unknown })._id);
  }
  const raw = String(value);
  return mongoose.isValidObjectId(raw) ? raw : null;
}

async function withStaffProfiles<T extends { staffId?: any }>(rows: T[]) {
  const staffUserIds = [
    ...new Set(rows.map((row) => staffUserKey(row.staffId)).filter(Boolean)),
  ] as string[];
  const profiles = staffUserIds.length
    ? await StaffProfile.find({
        userId: mongoose.trusted({
          $in: staffUserIds.map((id) => new mongoose.Types.ObjectId(id)),
        }),
      })
        .select('_id userId employeeCode')
        .lean()
    : [];
  const byUser = Object.fromEntries(
    profiles.map((profile: { _id: unknown; userId: unknown; employeeCode?: string }) => [
      String(profile.userId),
      profile,
    ]),
  );

  return rows.map((row) => {
    const userId = staffUserKey(row.staffId);
    const profile = userId ? byUser[userId] : undefined;
    return {
      ...row,
      staffProfileId: profile?._id ?? null,
      employeeCode: profile?.employeeCode ?? null,
    };
  });
}

export async function listCashSubmissions(
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'submissionDate';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = CashSubmission.find(filter)
    .populate('staffId', 'name phone')
    .populate('receivedBy', 'name phone')
    .populate('createdBy', 'name phone');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    const page = buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row: any) => new Date(row.submissionDate),
      (row: any) => row._id,
    );
    return { ...page, items: await withStaffProfiles(page.items as Array<{ staffId?: any }>) };
  }

  const [rows, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    CashSubmission.countDocuments(),
  ]);
  const page = buildOffsetPage(rows, total, query.page, query.limit);
  return {
    ...page,
    items: await withStaffProfiles(page.items as Array<{ staffId?: any }>),
  };
}

export async function listPayouts(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'payoutDate';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = Payout.find(filter)
    .populate({ path: 'customerId', populate: { path: 'userId', select: 'name phone' } })
    .populate({
      path: 'schemeId',
      select: 'enrollmentNumber schemeType status',
      populate: { path: 'schemePlanId', select: 'name type' },
    })
    .populate('createdBy', 'name phone');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.payoutDate),
      (row) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    Payout.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function listCorrections(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'createdAt';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = PaymentCorrection.find(filter);

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
    PaymentCorrection.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function staffCashBalance(staffId: string, session?: any) {
  const staffObjectId = new mongoose.Types.ObjectId(staffId);
  const [payments, submissions] = await Promise.all([
    Payment.aggregate([
      {
        $match: {
          collectedBy: staffObjectId,
          collectorRole: 'STAFF',
          method: 'CASH',
          status: 'SUCCESS',
        },
      },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]).session(session ?? null),
    CashSubmission.aggregate([
      { $match: { staffId: staffObjectId, status: 'SUCCESS' } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]).session(session ?? null),
  ]);
  return (payments[0]?.total ?? 0) - (submissions[0]?.total ?? 0);
}

export async function listStaffCashHeld() {
  const profiles = await StaffProfile.find()
    .populate('userId', 'name phone status')
    .lean();
  return Promise.all(
    profiles.map(async (profile: any) => {
      const staffId = String(profile.userId?._id ?? profile.userId);
      const cashHeldPaise = await staffCashBalance(staffId);
      return {
        staffId,
        staffProfileId: profile._id,
        employeeCode: profile.employeeCode,
        name: profile.userId?.name ?? null,
        phone: profile.userId?.phone ?? null,
        status: profile.userId?.status ?? null,
        cashHeldPaise,
      };
    }),
  );
}
export async function submitCash(
  input: { staffId: string; amountPaise: number; submissionDate: Date; notes?: string },
  context: AuditContext & { actorId: string },
) {
  paise(input.amountPaise);
  return withMongoTransaction(async (session) => {
    const staffObjectId = new mongoose.Types.ObjectId(input.staffId);
    const profile = await StaffProfile.findOne({ userId: staffObjectId }).session(session);
    if (!profile) throw new AppError('STAFF_NOT_FOUND', 'Staff member not found', 404);
    // Serialize concurrent cash submissions for the same staff member.
    const profileLock = await StaffProfile.updateOne(
      { _id: profile._id, __v: profile.__v },
      { $set: { updatedBy: context.actorId } },
      { session },
    );
    if (profileLock.modifiedCount !== 1) {
      throw new AppError(
        'STAFF_CASH_BUSY',
        'Staff cash is being updated by another submission. Retry shortly.',
        409,
        true,
      );
    }

    const available = await staffCashBalance(input.staffId, session);
    if (input.amountPaise <= 0 || input.amountPaise > available)
      throw new AppError(
        'INSUFFICIENT_STAFF_CASH',
        'Cash submission exceeds available staff cash',
        409,
        false,
        [{ availablePaise: available }],
      );
    const [record] = await CashSubmission.create(
      [{ ...input, receivedBy: context.actorId, createdBy: context.actorId }],
      { session },
    );
    const remaining = await staffCashBalance(input.staffId, session);
    if (remaining < 0) {
      throw new AppError(
        'INSUFFICIENT_STAFF_CASH',
        'Cash submission exceeds available staff cash',
        409,
        false,
        [{ availablePaise: available }],
      );
    }
    await audit(
      session,
      context,
      'CASH_SUBMITTED',
      'CashSubmission',
      record._id,
      undefined,
      record.toObject(),
    );
    await outbox(session, 'CASH_SUBMITTED', 'CashSubmission', record._id, {
      staffId: input.staffId,
      amountPaise: input.amountPaise,
    });
    return record;
  }, context.requestId);
}
export async function reversePayment(
  paymentId: string,
  reason: string,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const payment = await Payment.findOne({ _id: paymentId, status: 'SUCCESS' }).session(session);
    if (!payment)
      throw new AppError(
        'PAYMENT_NOT_REVERSIBLE',
        'Successful payment not found or already reversed',
        409,
      );
    // Gateway-origin money must never move via local reversal — checked before
    // any other read/mutation so a gateway payment reversal attempt is a pure
    // no-op besides this rejection.
    assertNotGatewayOrigin(payment);
    await assertDateInOpenPeriod(payment.paymentDate, session);

    const lockOwner = `reversal:${context.actorId}:${randomLockId()}`;
    await claimEnrollmentSettlementLock(
      payment.schemeId,
      lockOwner,
      session,
      SETTLEMENT_LOCK_REFUND_STATUSES,
    );
    try {
      // Re-check inside the lock: refund initiation, correction approval, and
      // redemption/payout must not race a manual reversal on the same enrollment.
      await assertNoBlockingSettlementActivity(payment.schemeId, session);

      const before = payment.toObject();
      await assertEnrollmentSolvent(String(payment.schemeId), session, {
        paidPaise: -payment.amountPaise,
        goldWeightMg: -(payment.goldWeightMg ?? 0),
        paymentsCompleted: -1,
      });
      payment.status = 'REVERSED';
      payment.reversedAt = new Date();
      payment.reversedBy = context.actorId;
      payment.reversalReason = reason;
      await payment.save({ session });
      await syncEnrollmentFromLedger(String(payment.schemeId), session);
      await audit(
        session,
        context,
        'PAYMENT_REVERSED',
        'Payment',
        payment._id,
        before,
        payment.toObject(),
      );
      await outbox(session, 'PAYMENT_REVERSED', 'Payment', payment._id, { paymentId: payment._id });
      return payment;
    } finally {
      await clearEnrollmentSettlementLock(payment.schemeId, lockOwner, session);
    }
  }, context.requestId);
}
export async function createPayout(
  input: {
    customerId: string;
    schemeId: string;
    payoutDate: Date;
    payoutType: 'PAYOUT' | 'REDEEM';
    settlementAsset?: 'GOLD' | 'CASH';
    method?: 'CASH' | 'BANK' | 'UPI';
    referenceNumber?: string;
    notes?: string;
    idempotencyKey?: string;
  },
  context: AuditContext & { actorId: string },
) {
  const { resolveRedemptionAsset, resolveSettlementPolicy, executeSchemeSettlement } =
    await import('./scheme-settlement.service.js');
  const scheme = await SchemeEnrollment.findById(input.schemeId);
  if (!scheme || String(scheme.customerId) !== input.customerId) {
    throw new AppError('SCHEME_NOT_FOUND', 'Customer scheme not found', 404);
  }
  if (scheme.schemeType === 'CASH' && input.payoutType !== 'PAYOUT') {
    throw new AppError(
      'USE_CASH_PAYOUT_FLOW',
      'CASH schemes complete through PAYOUT, not GOLD_WEIGHT redemption',
      422,
    );
  }
  if (scheme.schemeType !== 'CASH' && input.payoutType !== 'REDEEM') {
    throw new AppError(
      'USE_REDEMPTION_FLOW',
      'GOLD_WEIGHT schemes complete through REDEEM',
      422,
    );
  }
  const policy = resolveSettlementPolicy(scheme.toObject());
  const settlementAsset =
    scheme.schemeType === 'CASH' ? 'CASH' : resolveRedemptionAsset(input.settlementAsset, policy);
  if (scheme.schemeType === 'CASH' && input.settlementAsset === 'GOLD') {
    throw new AppError(
      'SETTLEMENT_ASSET_NOT_ALLOWED',
      'Live CASH schemes settle in cash only',
      409,
    );
  }
  return executeSchemeSettlement(
    {
      enrollmentId: input.schemeId,
      customerId: input.customerId,
      kind: 'REDEEM',
      settlementAsset,
      payoutDate: input.payoutDate,
      referenceNumber: input.referenceNumber,
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
      disbursementMethod: input.method,
    },
    context,
  );
}
export async function requestCorrection(
  paymentId: string,
  input: any,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const [payment, pending] = await Promise.all([
      Payment.findOne({
        _id: paymentId,
        collectedBy: context.actorId,
        status: 'SUCCESS',
      }).session(session),
      PaymentCorrection.findOne({
        paymentId,
        requestedBy: context.actorId,
        status: 'PENDING',
      }).session(session),
    ]);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Eligible payment not found', 404);
    if (input.correctionType === 'CHANGE_DATE') {
      throw new AppError(
        'CORRECTION_TYPE_DISABLED',
        'Payment date corrections are not allowed',
        422,
      );
    }
    if (pending)
      throw new AppError(
        'CORRECTION_ALREADY_PENDING',
        'This payment already has a pending correction request',
        409,
      );
    const [correction] = await PaymentCorrection.create(
      [
        {
          paymentId,
          requestedBy: context.actorId,
          correctionType: input.correctionType,
          originalSnapshot: payment.toObject(),
          requestedChanges: input.requestedChanges,
          reason: input.reason,
        },
      ],
      { session },
    );
    await audit(
      session,
      context,
      'CORRECTION_REQUESTED',
      'PaymentCorrection',
      correction._id,
      undefined,
      correction.toObject(),
    );
    await outbox(session, 'CORRECTION_REQUESTED', 'PaymentCorrection', correction._id, {
      paymentId: payment._id,
      requestedBy: context.actorId,
    });
    return correction;
  }, context.requestId);
}
export async function reviewCorrection(
  correctionId: string,
  decision: 'APPROVED' | 'REJECTED',
  reviewNotes: string,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const existing = await PaymentCorrection.findById(correctionId).session(session);
    if (!existing) throw new AppError('CORRECTION_NOT_FOUND', 'Pending correction not found', 404);
    if (String(existing.requestedBy) === String(context.actorId)) {
      throw new AppError(
        'CORRECTION_SELF_REVIEW_FORBIDDEN',
        'The requester cannot approve or reject their own correction',
        403,
      );
    }
    if (existing.status !== 'PENDING') {
      if (existing.status === decision && String(existing.reviewedBy) === String(context.actorId)) {
        if (decision === 'REJECTED') return existing;
        const replacement = existing.replacementPaymentId
          ? await Payment.findById(existing.replacementPaymentId).session(session)
          : null;
        return { correction: existing, replacement };
      }
      throw new AppError(
        'CORRECTION_ALREADY_REVIEWED',
        'This correction has already been reviewed',
        409,
      );
    }
    if (decision === 'APPROVED' && existing.correctionType === 'CHANGE_DATE') {
      throw new AppError(
        'CORRECTION_TYPE_DISABLED',
        'Payment date corrections are not allowed',
        422,
      );
    }

    const claimed = await PaymentCorrection.findOneAndUpdate(
      { _id: correctionId, status: 'PENDING' },
      {
        $set: {
          status: decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
          reviewedBy: context.actorId,
          reviewedAt: new Date(),
          reviewNotes,
        },
      },
      { session, new: true },
    );
    if (!claimed) {
      const raced = await PaymentCorrection.findById(correctionId).session(session);
      if (
        raced &&
        raced.status === decision &&
        String(raced.reviewedBy) === String(context.actorId)
      ) {
        if (decision === 'REJECTED') return raced;
        const replacement = raced.replacementPaymentId
          ? await Payment.findById(raced.replacementPaymentId).session(session)
          : null;
        return { correction: raced, replacement };
      }
      throw new AppError(
        'CORRECTION_ALREADY_REVIEWED',
        'This correction has already been reviewed',
        409,
      );
    }

    if (decision === 'REJECTED') {
      await audit(
        session,
        context,
        'CORRECTION_REJECTED',
        'PaymentCorrection',
        claimed._id,
        undefined,
        claimed.toObject(),
      );
      return claimed;
    }

    const payment = await Payment.findOne({ _id: claimed.paymentId, status: 'SUCCESS' }).session(
      session,
    );
    if (!payment)
      throw new AppError('PAYMENT_NOT_REVERSIBLE', 'Original payment is no longer eligible', 409);

    // CHANGE_NOTES and CHANGE_REFERENCE touch only merchant-entered metadata —
    // never the gateway identity (merchantTransactionId / providerTransactionId)
    // or any financial field — so they are applied in place, for every payment
    // origin, without reversing/recreating the Payment. This also means a
    // gateway payment's own notes/reference can still be corrected without
    // routing through a refund.
    if (claimed.correctionType === 'CHANGE_NOTES' || claimed.correctionType === 'CHANGE_REFERENCE') {
      const changes = claimed.requestedChanges ?? {};
      const before = payment.toObject();
      if (claimed.correctionType === 'CHANGE_NOTES') {
        payment.notes = changes.notes != null ? String(changes.notes) : payment.notes;
      } else {
        payment.referenceNumber =
          changes.referenceNumber != null ? String(changes.referenceNumber) : payment.referenceNumber;
      }
      payment.updatedBy = context.actorId;
      await payment.save({ session });

      await audit(
        session,
        context,
        'CORRECTION_APPROVED',
        'PaymentCorrection',
        claimed._id,
        before,
        { correction: claimed.toObject(), payment: payment.toObject() },
      );
      await outbox(session, 'PAYMENT_CORRECTED', 'PaymentCorrection', claimed._id, {
        originalPaymentId: payment._id,
        replacementPaymentId: null,
      });
      return { correction: claimed, replacement: null };
    }

    // Every remaining correction type (CHANGE_AMOUNT / CHANGE_METHOD /
    // CHANGE_REFERENCE already handled / REVERSE_PAYMENT) reverses and —
    // except for REVERSE_PAYMENT — recreates the Payment. That is never
    // acceptable for gateway money: the provider fact is not ours to rewrite.
    assertNotGatewayOrigin(payment);

    const originalAccountingDate = payment.accountingDate ?? payment.paymentDate;
    await assertDateInOpenPeriod(originalAccountingDate, session);

    const lockOwner = `correction:${context.actorId}:${randomLockId()}`;
    await claimEnrollmentSettlementLock(
      payment.schemeId,
      lockOwner,
      session,
      SETTLEMENT_LOCK_REFUND_STATUSES,
    );
    try {
      await assertNoBlockingSettlementActivity(payment.schemeId, session);

      const before = payment.toObject();
      await assertEnrollmentSolvent(String(payment.schemeId), session, {
        paidPaise: -payment.amountPaise,
        goldWeightMg: -(payment.goldWeightMg ?? 0),
        paymentsCompleted: -1,
      });
      payment.status = 'REVERSED';
      payment.reversedAt = new Date();
      payment.reversedBy = context.actorId;
      payment.reversalReason = `Approved correction ${claimed._id}`;
      await payment.save({ session });
      let replacement: any = null;
      if (claimed.correctionType !== 'REVERSE_PAYMENT') {
        const changes = claimed.requestedChanges ?? {};
        const amountPaise =
          claimed.correctionType === 'CHANGE_AMOUNT'
            ? paise(Number(changes.amountPaise))
            : payment.amountPaise;
        const method =
          claimed.correctionType === 'CHANGE_METHOD' ? String(changes.method) : payment.method;
        const paymentDate = payment.paymentDate;
        if (
          amountPaise <= 0 ||
          !['CASH', 'UPI', 'BANK', 'CARD'].includes(method) ||
          Number.isNaN(paymentDate.getTime())
        )
          throw new AppError('INVALID_CORRECTION', 'Requested correction is invalid', 422);
        const rules = await getPaymentRules(
          String(payment.schemeId),
          paymentDate,
          amountPaise,
          session,
          { targetSchemeMonth: payment.schemeMonth },
        );
        let gold: any = {};
        if (rules.enrollment.schemeType === 'GOLD_WEIGHT') {
          const rate = await activeGoldRate(paymentDate, session);
          gold = {
            goldRateId: rate._id,
            goldRatePerGramPaise: rate.ratePerGramPaise,
            goldPurity: rate.purity,
            goldWeightMg: goldWeightMg(amountPaise, rate.ratePerGramPaise),
          };
          await GoldRate.updateOne({ _id: rate._id }, { $inc: { usageCount: 1 } }, { session });
        }
        const [created] = await Payment.create(
          [
            {
              customerId: payment.customerId,
              schemeId: payment.schemeId,
              amountPaise,
              method,
              status: 'SUCCESS',
              paymentDate,
              accountingDate: paymentDate,
              recognizedAt: new Date(),
              schemeMonth: rules.schemeMonth,
              receiptNumber: await allocateReceiptNumber(session, paymentDate),
              referenceNumber: payment.referenceNumber,
              notes: payment.notes,
              collectedBy: payment.collectedBy,
              collectorRole: payment.collectorRole,
              supersedesPaymentId: payment._id,
              correctionId: claimed._id,
              createdBy: context.actorId,
              ...gold,
            },
          ],
          { session },
        );
        replacement = created;
        claimed.replacementPaymentId = created._id;
        await PaymentCorrection.updateOne(
          { _id: claimed._id },
          { $set: { replacementPaymentId: created._id } },
          { session },
        );
      }
      await syncEnrollmentFromLedger(String(payment.schemeId), session);
      await audit(
        session,
        context,
        'CORRECTION_APPROVED',
        'PaymentCorrection',
        claimed._id,
        before,
        { correction: claimed.toObject(), replacementPaymentId: replacement?._id },
      );
      await outbox(session, 'PAYMENT_CORRECTED', 'PaymentCorrection', claimed._id, {
        originalPaymentId: payment._id,
        replacementPaymentId: replacement?._id,
      });
      return { correction: claimed, replacement };
    } finally {
      await clearEnrollmentSettlementLock(payment.schemeId, lockOwner, session);
    }
  }, context.requestId);
}
