import { formatCustomerCode, LIVE_SCHEME_TYPE } from "../config/business.js";
import mongoose from "mongoose";
import {
  Customer,
  GoldRate,
  Nominee,
  ReceiptCounter,
  SchemeEnrollment,
  SchemePlan,
  User,
} from "../models/index.js";
import { hashPassword } from "./auth.service.js";
import { enrollmentDates } from "./scheme.service.js";
import { buildPlanSnapshot } from "../utils/scheme-contract.js";
import { LIVE_CASH_SETTLEMENT_POLICY } from "../utils/payment-window.js";

export const DEMO_PASSWORD = "Nakshathra@123";
export const ADMIN_PHONE = "+919999999901";
export const CUSTOMER_PHONE = "+919999999903";
export const NOMINEE_PHONE = "+919999999904";

const PASSBOOK_SCOPE = "CUSTOMER-PASSBOOK";

export async function insertDemoData() {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const admin = await User.create({
    name: "Nakshathra Admin",
    phone: ADMIN_PHONE,
    passwordHash,
    role: "ADMIN",
    status: "ACTIVE",
  });

  const customerUser = await User.create({
    name: "Demo Customer",
    phone: CUSTOMER_PHONE,
    passwordHash,
    role: "CUSTOMER",
    status: "ACTIVE",
    createdBy: admin._id,
  });

  const nominee = await Nominee.create({
    name: "Demo Nominee",
    relationship: "Spouse",
    phone: NOMINEE_PHONE,
    createdBy: admin._id,
  });

  const customer = await Customer.create({
    userId: customerUser._id,
    customerCode: formatCustomerCode(1),
    nomineeId: nominee._id,
    status: "ACTIVE",
    kycStatus: "VERIFIED",
    createdBy: admin._id,
  });

  await ReceiptCounter.create({ scope: PASSBOOK_SCOPE, value: 1 });

  const plan = await SchemePlan.create({
    name: "Nakshathra Cash 11",
    type: LIVE_SCHEME_TYPE,
    durationMonths: 11,
    redemptionMonth: 12,
    flexibleMonths: 6,
    capMonths: 5,
    capStrategy: "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
    contributionPolicyVersion: 1,
    ...LIVE_CASH_SETTLEMENT_POLICY,
    minimumPaymentPaise: 100_000,
    makingChargeWaiverPercent: 100,
    gstRateBasisPoints: 300,
    termsText:
      "Contribute for 11 months. Months 1-6 are flexible; months 7-11 follow the live scheme contract.",
    benefitText: "Cash savings scheme. Gold-weight settlement is not used for live enrollments.",
    makingChargeBenefit: "100% waiver",
    status: "ACTIVE",
    createdBy: admin._id,
  });

  const start = new Date();
  const dates = enrollmentDates(start, 6, 11);

  await SchemeEnrollment.create({
    customerId: customer._id,
    schemePlanId: plan._id,
    enrollmentNumber: "NKS-ENR-000001",
    schemeType: LIVE_SCHEME_TYPE,
    startDate: start,
    ...dates,
    durationMonths: 11,
    flexibleMonths: 6,
    capMonths: 5,
    capStrategy: "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
    contributionPolicyVersion: 1,
    monthlyInstallmentPaise: 100_000,
    makingChargeWaiverPercent: 100,
    gstRateBasisPoints: 300,
    schemePlanVersion: plan.version ?? 1,
    planSnapshot: buildPlanSnapshot(plan),
    snapshotSource: "ENROLLMENT",
    snapshotCapturedAt: new Date(),
    status: "ACTIVE",
    statusHistory: [{ status: "ACTIVE", at: new Date(), actorId: admin._id }],
    createdBy: admin._id,
  });

  const effectiveFrom = new Date();
  effectiveFrom.setHours(0, 0, 0, 0);

  await GoldRate.create({
    ratePerGramPaise: 750_000,
    purity: "916",
    effectiveFrom,
    status: "ACTIVE",
    notes: "Development seed rate",
    createdBy: admin._id,
  });

  return { admin, customerUser, customer, plan };
}

/** Idempotent bootstrap used when BOOTSTRAP_DEMO=true on server start. */
export async function seedDemoData() {
  const existing = await User.exists({ phone: ADMIN_PHONE });
  if (existing) return;

  await insertDemoData();
}

export async function resetAndSeedDemoData() {
  await mongoose.connection.dropDatabase();
  await insertDemoData();
}
