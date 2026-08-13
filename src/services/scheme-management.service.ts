import type { ListPageResult, ListQuery } from "../utils/cursor-pagination.js";
import { type ClientSession } from "mongoose";
import { LIVE_CONTRIBUTION_DEFAULTS } from "../utils/contribution-policy.js";
import { formatEnrollmentNumber, isGoldWeightEnabled, LIVE_SCHEME_TYPE } from "../config/business.js";
import { AppError } from "../utils/AppError.js";
import { withMongoTransaction } from "../utils/transaction.js";
import {
  Customer,
  GoldRate,
  Payment,
  Payout,
  ReceiptCounter,
  SchemeEnrollment,
  SchemePlan,
} from "../models/index.js";
import { enrollmentDates } from "./scheme.service.js";
import {
  buildInstallmentSchedule,
  summarizeInstallmentSchedule,
} from "./installment-schedule.service.js";
import { businessDayRange, businessYear } from "../utils/time.js";
import { audit, outbox, type AuditContext } from "./audit.service.js";
import { aggregateEnrollmentLedger } from "../utils/enrollment-ledger.js";
import { buildPlanSnapshot, withEnrollmentContract } from "../utils/scheme-contract.js";
import {
  DEFAULT_PAYMENT_WINDOW,
  LIVE_CASH_SETTLEMENT_POLICY,
  validatePaymentWindow,
  validateSettlementPolicy,
} from "../utils/payment-window.js";
import { assertCustomerCanStartFinancialActivity } from "./customer-financial-policy.service.js";
import type {
  CreateEnrollmentInput,
  CreateGoldRateInput,
  CreateSchemePlanInput,
  PrematureCloseInput,
  UpdateGoldRateInput,
  UpdateSchemePlanInput,
} from "../validators/scheme.validators.js";
import {
  assertEnrollmentUnusedForCancel,
  listDueEnrollments,
  listEnrollmentsFiltered,
  listOverdueEnrollments,
  listRedemptionReadyEnrollments,
  type EnrollmentListFilters,
} from "./enrollment-collection.service.js";
import { executeSchemeSettlement, previewSchemeSettlement } from "./scheme-settlement.service.js";

const ENROLLMENT_SCOPE_PREFIX = "ENROLLMENT";

function assertGoldWeightEnabled() {
  if (!isGoldWeightEnabled()) {
    throw new AppError(
      "GOLD_WEIGHT_DISABLED",
      "GOLD_WEIGHT functionality is not enabled for this deployment",
      409,
    );
  }
}

export async function allocateEnrollmentNumber(
  session: ClientSession,
  startDate: Date,
) {
  const year = businessYear(startDate);
  const counter = await ReceiptCounter.findOneAndUpdate(
    { scope: `${ENROLLMENT_SCOPE_PREFIX}-${year}` },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session, setDefaultsOnInsert: true },
  );
  return formatEnrollmentNumber(year, counter.value);
}

export async function createEnrollmentRecord(
  input: CreateEnrollmentInput,
  context: AuditContext & { actorId: string },
  session: ClientSession,
) {
  const [customer, plan] = await Promise.all([
    Customer.findById(input.customerId).session(session),
    SchemePlan.findOne({ _id: input.schemePlanId, status: "ACTIVE" }).session(session),
  ]);
  if (!customer || !plan) {
    throw new AppError(
      "ENROLLMENT_INPUT_INVALID",
      "Customer or active plan not found",
      404,
    );
  }
  if (plan.type !== LIVE_SCHEME_TYPE) {
    throw new AppError(
      "SCHEME_TYPE_NOT_LIVE",
      "Only CASH schemes can be enrolled for live Nakshathra product",
      422,
    );
  }
  await assertCustomerCanStartFinancialActivity(String(customer._id), session);
  const existingActiveEnrollment = await SchemeEnrollment.exists({
    customerId: customer._id,
    status: "ACTIVE",
  }).session(session);
  if (existingActiveEnrollment) {
    throw new AppError(
      "CUSTOMER_ALREADY_ENROLLED",
      "This customer already has an active scheme. Complete or settle it before enrolling again.",
      409,
    );
  }

  const enrollmentNumber =
    input.enrollmentNumber?.trim() ||
    (await allocateEnrollmentNumber(session, input.startDate));
  const dates = enrollmentDates(
    input.startDate,
    plan.flexibleMonths,
    plan.durationMonths,
  );
  if (input.monthlyInstallmentPaise < plan.minimumPaymentPaise) {
    throw new AppError(
      "INSTALLMENT_BELOW_MINIMUM",
      `Monthly installment must be at least ₹${(plan.minimumPaymentPaise / 100).toLocaleString("en-IN")}`,
      422,
    );
  }
  const planSnapshot = buildPlanSnapshot(plan.toObject());
  const [enrollment] = await SchemeEnrollment.create(
    [
      {
        customerId: input.customerId,
        schemePlanId: input.schemePlanId,
        enrollmentNumber,
        startDate: input.startDate,
        ...dates,
        schemeType: plan.type,
        durationMonths: plan.durationMonths,
        flexibleMonths: plan.flexibleMonths,
        capMonths: plan.capMonths,
        capStrategy: plan.capStrategy,
        contributionPolicyVersion: plan.contributionPolicyVersion,
        monthlyInstallmentPaise: input.monthlyInstallmentPaise,
        makingChargeWaiverPercent: plan.makingChargeWaiverPercent,
        gstRateBasisPoints: plan.gstRateBasisPoints,
        schemePlanVersion: plan.version ?? 1,
        paymentWindowType: planSnapshot.paymentWindowType,
        fixedPaymentDay: planSnapshot.fixedPaymentDay,
        paymentWindowStartDay: planSnapshot.paymentWindowStartDay,
        paymentWindowEndDay: planSnapshot.paymentWindowEndDay,
        prematureClosureEnabled: planSnapshot.prematureClosureEnabled,
        prematureClosureMinPaidInstallments: planSnapshot.prematureClosureMinPaidInstallments,
        prematureClosureSettlementAssets: planSnapshot.prematureClosureSettlementAssets,
        maturitySettlementAssets: planSnapshot.maturitySettlementAssets,
        prematureClosureCashBasis: planSnapshot.prematureClosureCashBasis,
        maturityCashBasis: planSnapshot.maturityCashBasis,
        planSnapshot,
        snapshotSource: "ENROLLMENT",
        snapshotCapturedAt: new Date(),
        statusHistory: [{ status: "ACTIVE", at: new Date(), actorId: context.actorId }],
        createdBy: context.actorId,
      },
    ],
    { session },
  );
  await audit(
    session,
    context,
    "SCHEME_ENROLLED",
    "SchemeEnrollment",
    enrollment._id,
    undefined,
    enrollment.toObject(),
  );
  await outbox(session, "SCHEME_ENROLLED", "SchemeEnrollment", enrollment._id, {
    customerId: customer._id,
  });
  return enrollment;
}

export const createSchemePlan = (
  input: CreateSchemePlanInput,
  context: AuditContext & { actorId: string },
) =>
  withMongoTransaction(async (session) => {
    const paymentWindow = validatePaymentWindow({
      paymentWindowType: input.paymentWindowType ?? DEFAULT_PAYMENT_WINDOW.paymentWindowType,
      fixedPaymentDay: input.fixedPaymentDay,
      paymentWindowStartDay: input.paymentWindowStartDay,
      paymentWindowEndDay: input.paymentWindowEndDay,
    });
    const settlementPolicy = validateSettlementPolicy(LIVE_CASH_SETTLEMENT_POLICY);
    const [plan] = await SchemePlan.create(
      [
        {
          ...input,
          ...paymentWindow,
          ...settlementPolicy,
          type: LIVE_SCHEME_TYPE,
          durationMonths: LIVE_CONTRIBUTION_DEFAULTS.durationMonths,
          redemptionMonth: 12,
          flexibleMonths: LIVE_CONTRIBUTION_DEFAULTS.flexibleMonths,
          capMonths: LIVE_CONTRIBUTION_DEFAULTS.capMonths,
          capStrategy: LIVE_CONTRIBUTION_DEFAULTS.capStrategy,
          contributionPolicyVersion: LIVE_CONTRIBUTION_DEFAULTS.contributionPolicyVersion,
          makingChargeWaiverPercent: 100,
          gstRateBasisPoints: 300,
          version: 1,
          createdBy: context.actorId,
        },
      ],
      { session },
    );
    await audit(
      session,
      context,
      "SCHEME_PLAN_CREATED",
      "SchemePlan",
      plan._id,
      undefined,
      plan.toObject(),
    );
    return plan;
  }, context.requestId);

export const listSchemePlans = () =>
  SchemePlan.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(500).lean();

export const listActiveSchemePlans = () =>
  SchemePlan.find({ deletedAt: null, status: "ACTIVE", type: LIVE_SCHEME_TYPE })
    .sort({ name: 1 })
    .limit(500)
    .lean();

export async function getSchemePlan(planId: string) {
  const plan = await SchemePlan.findOne({
    _id: planId,
    deletedAt: null,
  }).lean();
  if (!plan)
    throw new AppError("SCHEME_PLAN_NOT_FOUND", "Scheme plan not found", 404);
  return plan;
}

export async function updateSchemePlan(
  planId: string,
  input: UpdateSchemePlanInput,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const plan = await SchemePlan.findOne({
      _id: planId,
      deletedAt: null,
    }).session(session);
    if (!plan)
      throw new AppError("SCHEME_PLAN_NOT_FOUND", "Scheme plan not found", 404);
    const before = plan.toObject();
    const nextWindow = validatePaymentWindow({
      paymentWindowType: input.paymentWindowType ?? plan.paymentWindowType,
      fixedPaymentDay:
        input.fixedPaymentDay ??
        (input.paymentWindowType === "DATE_RANGE" ? undefined : plan.fixedPaymentDay),
      paymentWindowStartDay:
        input.paymentWindowStartDay ??
        (input.paymentWindowType === "FIXED_DAY" ? undefined : plan.paymentWindowStartDay),
      paymentWindowEndDay:
        input.paymentWindowEndDay ??
        (input.paymentWindowType === "FIXED_DAY" ? undefined : plan.paymentWindowEndDay),
    });
    const nextPolicy = validateSettlementPolicy(LIVE_CASH_SETTLEMENT_POLICY);
    Object.assign(plan, input, nextWindow, nextPolicy, {
      type: LIVE_SCHEME_TYPE,
      durationMonths: 11,
      redemptionMonth: 12,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      updatedBy: context.actorId,
    });
    if (nextWindow.paymentWindowType === "FIXED_DAY") {
      plan.paymentWindowStartDay = undefined;
      plan.paymentWindowEndDay = undefined;
    } else {
      plan.fixedPaymentDay = undefined;
    }
    plan.flexibleMonths = LIVE_CONTRIBUTION_DEFAULTS.flexibleMonths;
    plan.capMonths = LIVE_CONTRIBUTION_DEFAULTS.capMonths;
    plan.capStrategy = LIVE_CONTRIBUTION_DEFAULTS.capStrategy;
    plan.contributionPolicyVersion = LIVE_CONTRIBUTION_DEFAULTS.contributionPolicyVersion;
    plan.version = (Number(plan.version) || 1) + 1;
    await plan.save({ session });
    if (nextWindow.paymentWindowType === "DATE_RANGE") {
      await SchemePlan.updateOne(
        { _id: plan._id },
        { $unset: { fixedPaymentDay: 1 } },
        { session },
      );
    } else {
      await SchemePlan.updateOne(
        { _id: plan._id },
        { $unset: { paymentWindowStartDay: 1, paymentWindowEndDay: 1 } },
        { session },
      );
    }
    await audit(
      session,
      context,
      "SCHEME_PLAN_UPDATED",
      "SchemePlan",
      plan._id,
      before,
      plan.toObject(),
    );
    return plan;
  }, context.requestId);
}

export async function createEnrollment(
  input: CreateEnrollmentInput,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(
    (session) => createEnrollmentRecord(input, context, session),
    context.requestId,
  );
}

export async function listEnrollments(
  listQuery: ListQuery,
  filters: EnrollmentListFilters = {},
): Promise<ListPageResult<any>> {
  return listEnrollmentsFiltered(listQuery, filters);
}

export async function getEnrollmentDetails(enrollmentId: string) {
  const [enrollment, payments, payouts] = await Promise.all([
    SchemeEnrollment.findById(enrollmentId)
      .populate({
        path: "customerId",
        populate: { path: "userId", select: "name phone status" },
      })
      .populate("schemePlanId")
      .lean(),
    Payment.find({ schemeId: enrollmentId })
      .sort({ paymentDate: -1 })
      .limit(100)
      .populate('collectedBy', 'name phone')
      .lean(),
    Payout.find({ schemeId: enrollmentId }).sort({ payoutDate: -1 }).limit(50).lean(),
  ]);
  if (!enrollment)
    throw new AppError("SCHEME_NOT_FOUND", "Enrollment not found", 404);
  const installmentSchedule = buildInstallmentSchedule(enrollment, payments);
  return {
    enrollment: withEnrollmentContract(enrollment),
    payments,
    payouts,
    installmentSchedule,
    installmentSummary: summarizeInstallmentSchedule(installmentSchedule),
  };
}

export async function getActiveEnrollmentForCustomer(customerId: string) {
  const customer = await Customer.findById(customerId).lean();
  if (!customer) throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
  const active = await SchemeEnrollment.findOne({
    customerId,
    status: "ACTIVE",
  })
    .select("_id")
    .lean();
  if (!active) {
    throw new AppError(
      "ACTIVE_ENROLLMENT_NOT_FOUND",
      "This customer has no active scheme enrollment",
      404,
    );
  }
  return getEnrollmentDetails(String(active._id));
}

export async function updateEnrollmentStatus(
  enrollmentId: string,
  status: "ACTIVE" | "MATURED" | "REDEEMED" | "CLOSED" | "WITHDRAWN" | "CANCELLED",
  reason: string,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const enrollment =
      await SchemeEnrollment.findById(enrollmentId).session(session);
    if (!enrollment)
      throw new AppError("SCHEME_NOT_FOUND", "Enrollment not found", 404);
    if (["REDEEMED", "CLOSED", "WITHDRAWN", "CANCELLED"].includes(enrollment.status))
      throw new AppError("SCHEME_ALREADY_SETTLED", "Scheme is already settled", 409);
    if (status === "CANCELLED")
      throw new AppError(
        "USE_ENROLLMENT_CANCELLATION_FLOW",
        "Unused enrollments must be cancelled through the dedicated cancellation flow",
        409,
      );
    if (status === "REDEEMED")
      throw new AppError(
        "USE_PAYOUT_FLOW",
        "Redemption with scheme benefits must be recorded through the payout flow",
        409,
      );
    if (status === "CLOSED" || status === "WITHDRAWN")
      throw new AppError(
        "USE_PREMATURE_CLOSURE_FLOW",
        "Premature closure must be recorded through the dedicated settlement workflow",
        409,
      );
    if (status === "MATURED") {
      if (enrollment.schemeType === "CASH") {
        const maturityAt = new Date(
          enrollment.redemptionStartDate ?? enrollment.maturityDate,
        );
        if (new Date().getTime() < maturityAt.getTime()) {
          throw new AppError(
            "MATURITY_NOT_REACHED",
            "A CASH scheme can be marked matured only on or after its maturity date",
            409,
            false,
            [{ redemptionStartDate: enrollment.redemptionStartDate }],
          );
        }
      } else {
        const ledger = await aggregateEnrollmentLedger(String(enrollment._id), session);
        if (ledger.paymentsCompleted !== 11)
          throw new AppError(
            "INSTALLMENTS_INCOMPLETE",
            "All 11 monthly installments must be completed before marking matured",
            409,
            false,
            [{ completed: ledger.paymentsCompleted, required: 11 }],
          );
      }
    }
    const before = enrollment.toObject();
    enrollment.status = status;
    enrollment.updatedBy = context.actorId;
    enrollment.statusHistory.push({
      status,
      at: new Date(),
      actorId: context.actorId,
      reason,
    });
    await enrollment.save({ session });
    await audit(
      session,
      context,
      "SCHEME_STATUS_UPDATED",
      "SchemeEnrollment",
      enrollment._id,
      before,
      enrollment.toObject(),
    );
    await outbox(
      session,
      "SCHEME_STATUS_UPDATED",
      "SchemeEnrollment",
      enrollment._id,
      {
        customerId: enrollment.customerId,
        status,
      },
    );
    return enrollment;
  }, context.requestId);
}

export async function cancelEnrollment(
  enrollmentId: string,
  reason: string,
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const { enrollment } = await assertEnrollmentUnusedForCancel(enrollmentId, session);
    if (enrollment.status === "CANCELLED") return enrollment;
    const before = enrollment.toObject();
    enrollment.status = "CANCELLED";
    enrollment.updatedBy = context.actorId;
    enrollment.statusHistory.push({
      status: "CANCELLED",
      at: new Date(),
      actorId: context.actorId,
      reason,
    });
    await enrollment.save({ session });
    await audit(
      session,
      context,
      "ENROLLMENT_CANCELLED",
      "SchemeEnrollment",
      enrollment._id,
      before,
      enrollment.toObject(),
    );
    await outbox(session, "ENROLLMENT_CANCELLED", "SchemeEnrollment", enrollment._id, {
      customerId: enrollment.customerId,
      reason,
    });
    return enrollment;
  }, context.requestId);
}

export function listOverdueCollection(listQuery: ListQuery, filters: EnrollmentListFilters = {}) {
  return listOverdueEnrollments(listQuery, filters);
}

export function listDueCollection(listQuery: ListQuery, filters: EnrollmentListFilters = {}) {
  return listDueEnrollments(listQuery, filters);
}

export function listRedemptionReadyCollection(
  listQuery: ListQuery,
  filters: EnrollmentListFilters = {},
) {
  return listRedemptionReadyEnrollments(listQuery, filters);
}

export function previewPrematureClosure(
  enrollmentId: string,
  settlementAsset?: "GOLD" | "CASH",
) {
  return previewSchemeSettlement({
    enrollmentId,
    kind: "PREMATURE_CLOSE",
    settlementAsset,
  });
}

export function previewRedemption(enrollmentId: string, settlementAsset?: "GOLD" | "CASH") {
  return previewSchemeSettlement({
    enrollmentId,
    kind: "REDEEM",
    settlementAsset,
  });
}

export function prematureCloseEnrollment(
  enrollmentId: string,
  input: PrematureCloseInput,
  context: AuditContext & { actorId: string },
) {
  return executeSchemeSettlement(
    {
      enrollmentId,
      kind: "PREMATURE_CLOSE",
      settlementAsset: input.settlementAsset,
      payoutDate: input.payoutDate,
      reason: input.reason,
      referenceNumber: input.referenceNumber,
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
      disbursementMethod: input.method,
    },
    context,
  );
}

export const listGoldRates = () => {
  assertGoldWeightEnabled();
  return GoldRate.find().sort({ effectiveFrom: -1 }).limit(90).lean();
};

export async function getGoldRate(rateId: string) {
  assertGoldWeightEnabled();
  const rate = await GoldRate.findById(rateId)
    .populate('createdBy', 'name')
    .populate('updatedBy', 'name')
    .lean();
  if (!rate) throw new AppError('GOLD_RATE_NOT_FOUND', 'Gold rate not found', 404);
  return rate;
}

export async function createGoldRate(
  input: CreateGoldRateInput,
  context: AuditContext & { actorId: string },
) {
  assertGoldWeightEnabled();
  const rate = await withMongoTransaction(async (session) => {
    const { start } = businessDayRange(input.effectiveFrom);
    const [created] = await GoldRate.create(
      [{ ...input, effectiveFrom: start, createdBy: context.actorId }],
      {
        session,
      },
    );
    await audit(
      session,
      context,
      "GOLD_RATE_CREATED",
      "GoldRate",
      created._id,
      undefined,
      created.toObject(),
    );
    return created;
  }, context.requestId);
  const { publishGoldRateChange } = await import('../realtime/socket.js');
  void publishGoldRateChange(rate.toObject()).catch(() => undefined);
  return rate;
}

export async function updateGoldRate(
  rateId: string,
  input: UpdateGoldRateInput,
  context: AuditContext & { actorId: string },
) {
  assertGoldWeightEnabled();
  const rate = await withMongoTransaction(async (session) => {
    const existing = await GoldRate.findById(rateId).session(session);
    if (!existing)
      throw new AppError("GOLD_RATE_NOT_FOUND", "Gold rate not found", 404);
    const changesFinancialSnapshot =
      input.ratePerGramPaise !== undefined ||
      input.purity !== undefined ||
      input.effectiveFrom !== undefined;
    if (existing.usageCount > 0 && changesFinancialSnapshot) {
      throw new AppError(
        "GOLD_RATE_LOCKED",
        "A used gold rate cannot be financially edited",
        409,
      );
    }
    const before = existing.toObject();
    Object.assign(existing, input, {
      ...(input.effectiveFrom ? { effectiveFrom: businessDayRange(input.effectiveFrom).start } : {}),
      updatedBy: context.actorId,
    });
    await existing.save({ session });
    await audit(
      session,
      context,
      "GOLD_RATE_UPDATED",
      "GoldRate",
      existing._id,
      before,
      existing.toObject(),
    );
    return existing;
  }, context.requestId);
  const { publishGoldRateChange } = await import('../realtime/socket.js');
  void publishGoldRateChange(rate.toObject()).catch(() => undefined);
  return rate;
}
