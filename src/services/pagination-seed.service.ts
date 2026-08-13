import { LIVE_SCHEME_TYPE } from "../config/business.js";
import mongoose, { type Types } from "mongoose";
import {
  Customer,
  GoldRate,
  Nominee,
  Payment,
  PaymentIntent,
  Payout,
  ReceiptCounter,
  SchemeEnrollment,
  SchemePlan,
  User,
} from "../models/index.js";
import { hashPassword } from "./auth.service.js";
import {
  ADMIN_PHONE,
  DEMO_PASSWORD,
  insertDemoData,
} from "./demo-seed.service.js";
import { enrollmentDates } from "./scheme.service.js";
import { LIVE_CASH_SETTLEMENT_POLICY } from "../utils/payment-window.js";

/** Dedicated phone block so re-runs can clear only this seed. */
export const PAGINATION_PHONE_PREFIX = "+91970000";
export const PAGINATION_CUSTOMER_COUNT = 40;
export const PAGINATION_ENROLLMENT_PREFIX = "NKS-PAG-";
export const PAGINATION_CODE_BASE = 200_000;

const PASSBOOK_SCOPE = "CUSTOMER-PASSBOOK";
const INSTALLMENT_PAISE = 100_000;
const GOLD_RATE_PER_GRAM_PAISE = 750_000;

const FIRST_NAMES = [
  "Anitha",
  "Biju",
  "Chitra",
  "Deepak",
  "Elias",
  "Fathima",
  "Gopal",
  "Hema",
  "Irfan",
  "Jayasree",
  "Kiran",
  "Latha",
  "Manoj",
  "Nisha",
  "Omar",
  "Priya",
  "Qadir",
  "Ravi",
  "Sneha",
  "Thomas",
  "Uma",
  "Vineeth",
  "Wafa",
  "Xavier",
  "Yasmin",
  "Zayan",
  "Amal",
  "Bindu",
  "Cyril",
  "Divya",
  "Esha",
  "Fahad",
  "Geetha",
  "Hari",
  "Indu",
  "Jithin",
  "Kavya",
  "Lenin",
  "Meera",
  "Naveen",
];

const CITIES = [
  { city: "Thrissur", district: "Thrissur", state: "Kerala", postalCode: "680001" },
  { city: "Kochi", district: "Ernakulam", state: "Kerala", postalCode: "682001" },
  { city: "Kozhikode", district: "Kozhikode", state: "Kerala", postalCode: "673001" },
  { city: "Palakkad", district: "Palakkad", state: "Kerala", postalCode: "678001" },
  { city: "Kannur", district: "Kannur", state: "Kerala", postalCode: "670001" },
];

function paginationPhone(index: number) {
  return `${PAGINATION_PHONE_PREFIX}${String(index).padStart(4, "0")}`;
}

function customerCodeFor(index: number) {
  return String(PAGINATION_CODE_BASE + index).padStart(6, "0");
}

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function goldWeightMgFor(amountPaise: number, ratePerGramPaise: number) {
  // weight_mg = amount_paise * 1000 / rate_per_gram_paise
  return Math.floor((amountPaise * 1000) / ratePerGramPaise);
}

/** Remove only pagination-seed customers and their related docs. */
export async function clearPaginationSeedData() {
  const phones = Array.from({ length: PAGINATION_CUSTOMER_COUNT }, (_, idx) =>
    paginationPhone(idx + 1),
  );
  // Mongoose 8 sanitizes bare `$in` — wrap with mongoose.trusted (same pattern as report/staff services).
  const users = (await User.find({
    role: "CUSTOMER",
    phone: mongoose.trusted({ $in: phones }),
  })
    .select("_id")
    .lean()) as Array<{ _id: Types.ObjectId }>;
  const userIds = users.map((u) => u._id);
  if (userIds.length === 0) {
    return { removedCustomers: 0 };
  }

  const customers = (await Customer.find({
    userId: mongoose.trusted({ $in: userIds }),
  })
    .select("_id nomineeId")
    .lean()) as Array<{ _id: Types.ObjectId; nomineeId?: Types.ObjectId | null }>;
  const customerIds = customers.map((c) => c._id);
  const nomineeIds = customers
    .map((c) => c.nomineeId)
    .filter((id): id is Types.ObjectId => Boolean(id));

  const enrollments = (await SchemeEnrollment.find({
    customerId: mongoose.trusted({ $in: customerIds }),
  })
    .select("_id")
    .lean()) as Array<{ _id: Types.ObjectId }>;
  const enrollmentIds = enrollments.map((e) => e._id);

  await Promise.all([
    Payment.deleteMany({ customerId: mongoose.trusted({ $in: customerIds }) }),
    PaymentIntent.deleteMany({ customerId: mongoose.trusted({ $in: customerIds }) }),
    Payout.deleteMany({ customerId: mongoose.trusted({ $in: customerIds }) }),
    SchemeEnrollment.deleteMany({ _id: mongoose.trusted({ $in: enrollmentIds }) }),
    Customer.deleteMany({ _id: mongoose.trusted({ $in: customerIds }) }),
    Nominee.deleteMany({ _id: mongoose.trusted({ $in: nomineeIds }) }),
    User.deleteMany({ _id: mongoose.trusted({ $in: userIds }) }),
  ]);

  return { removedCustomers: customerIds.length };
}

async function ensureAdminAndPlan() {
  let admin = await User.findOne({ phone: ADMIN_PHONE, role: "ADMIN" });
  let plan = await SchemePlan.findOne({ status: "ACTIVE" }).sort({ createdAt: 1 });
  let goldRate = await GoldRate.findOne({ status: "ACTIVE", purity: "916" }).sort({
    effectiveFrom: -1,
  });

  if (!admin || !plan || !goldRate) {
    const existingAdmin = await User.exists({ phone: ADMIN_PHONE });
    if (!existingAdmin) {
      await insertDemoData();
    } else if (!plan) {
      const passwordHash = await hashPassword(DEMO_PASSWORD);
      admin =
        (await User.findOne({ phone: ADMIN_PHONE, role: "ADMIN" })) ??
        (await User.create({
          name: "Nakshathra Admin",
          phone: ADMIN_PHONE,
          passwordHash,
          role: "ADMIN",
          status: "ACTIVE",
        }));
      plan = await SchemePlan.create({
        name: "Nakshathra Cash 11",
        type: LIVE_SCHEME_TYPE,
        durationMonths: 11,
        redemptionMonth: 12,
        flexibleMonths: 6,
        capMonths: 5,
        capStrategy: "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
        contributionPolicyVersion: 1,
        ...LIVE_CASH_SETTLEMENT_POLICY,
        minimumPaymentPaise: INSTALLMENT_PAISE,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        termsText:
          "Pay one fixed installment for 11 months. Month 12 is redemption only.",
        benefitText: "100% making-charge waiver on accumulated gold weight.",
        makingChargeBenefit: "100% waiver",
        status: "ACTIVE",
        createdBy: admin!._id,
      });
    }

    admin = await User.findOne({ phone: ADMIN_PHONE, role: "ADMIN" });
    plan = await SchemePlan.findOne({ status: "ACTIVE" }).sort({ createdAt: 1 });
    goldRate = await GoldRate.findOne({ status: "ACTIVE", purity: "916" }).sort({
      effectiveFrom: -1,
    });

    if (!goldRate && admin) {
      const effectiveFrom = new Date();
      effectiveFrom.setHours(0, 0, 0, 0);
      goldRate = await GoldRate.create({
        ratePerGramPaise: GOLD_RATE_PER_GRAM_PAISE,
        purity: "916",
        effectiveFrom,
        status: "ACTIVE",
        notes: "Pagination seed rate",
        createdBy: admin._id,
      });
    }
  }

  if (!admin || !plan || !goldRate) {
    throw new Error("Failed to ensure admin, scheme plan, and gold rate for pagination seed");
  }

  return { admin, plan, goldRate };
}

export async function seedPaginationCustomers(options?: {
  count?: number;
  clearExisting?: boolean;
}) {
  const count = options?.count ?? PAGINATION_CUSTOMER_COUNT;
  if (options?.clearExisting !== false) {
    await clearPaginationSeedData();
  }

  const { admin, plan, goldRate } = await ensureAdminAndPlan();
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ratePaise = goldRate.ratePerGramPaise ?? GOLD_RATE_PER_GRAM_PAISE;

  let enrolled = 0;
  let paymentsCreated = 0;
  let intentsCreated = 0;
  let payoutsCreated = 0;
  let inactive = 0;

  for (let i = 1; i <= count; i++) {
    const name = `${FIRST_NAMES[(i - 1) % FIRST_NAMES.length]} Test ${String(i).padStart(2, "0")}`;
    const phone = paginationPhone(i);
    const inactiveCustomer = i % 9 === 0;
    if (inactiveCustomer) inactive += 1;
    const place = CITIES[(i - 1) % CITIES.length];
    const createdAt = daysAgo(count - i + 1);

    const customerUser = await User.create({
      name,
      phone,
      passwordHash,
      role: "CUSTOMER",
      status: inactiveCustomer ? "INACTIVE" : "ACTIVE",
      createdBy: admin._id,
      createdAt,
      updatedAt: createdAt,
    });

    let nomineeId;
    if (i % 2 === 0) {
      const nominee = await Nominee.create({
        name: `Nominee of ${name.split(" ")[0]}`,
        relationship: i % 4 === 0 ? "Spouse" : "Parent",
        phone: `+919701${String(i).padStart(6, "0")}`,
        createdBy: admin._id,
      });
      nomineeId = nominee._id;
    }

    const customer = await Customer.create({
      userId: customerUser._id,
      customerCode: customerCodeFor(i),
      nomineeId,
      status: inactiveCustomer ? "INACTIVE" : "ACTIVE",
      address: {
        line1: `${i} MG Road`,
        line2: "Near Temple",
        ...place,
      },
      createdBy: admin._id,
      createdAt,
      updatedAt: createdAt,
    });

    // ~25 enrollments so enrollments page also paginates (page size 10).
    const shouldEnroll = !inactiveCustomer && i <= 28;
    if (!shouldEnroll) continue;

    enrolled += 1;

    // A couple redeemed / matured for variety on detail pages.
    // Customer #1 is the mobile-app test account: 20+ payments across schemes for list pagination.
    const isMobileTestCustomer = i === 1;
    const isRedeemed = i === 2;
    const isMatured = i === 3;
    const weightPerPayment = goldWeightMgFor(INSTALLMENT_PAISE, ratePaise);

    const createEnrollmentWithPayments = async (opts: {
      enrollmentNumber: string;
      start: Date;
      status: "ACTIVE" | "MATURED" | "REDEEMED" | "CLOSED";
      monthsPaid: number;
      receiptPrefix: string;
    }) => {
      const dates = enrollmentDates(opts.start, 6, 11);
      const enrollment = await SchemeEnrollment.create({
        customerId: customer._id,
        schemePlanId: plan._id,
        enrollmentNumber: opts.enrollmentNumber,
        schemeType: plan.type,
        startDate: opts.start,
        ...dates,
        durationMonths: 11,
        flexibleMonths: 6,
        capMonths: 5,
        capStrategy: "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
        contributionPolicyVersion: 1,
        monthlyInstallmentPaise: INSTALLMENT_PAISE,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        paymentsCompleted: opts.monthsPaid,
        totalPaidPaise: opts.monthsPaid * INSTALLMENT_PAISE,
        totalGoldWeightMg: opts.monthsPaid * weightPerPayment,
        totalPayoutPaise:
          opts.status === "REDEEMED" ? opts.monthsPaid * INSTALLMENT_PAISE : 0,
        status: opts.status,
        statusHistory: [
          { status: "ACTIVE", at: opts.start, actorId: admin._id },
          ...(opts.status !== "ACTIVE"
            ? [
                {
                  status: opts.status,
                  at: daysAgo(5),
                  actorId: admin._id,
                  reason: "Pagination seed",
                },
              ]
            : []),
        ],
        createdBy: admin._id,
        createdAt: opts.start,
        updatedAt: opts.start,
      });

      for (let month = 1; month <= opts.monthsPaid; month++) {
        const paymentDate = new Date(opts.start);
        paymentDate.setDate(paymentDate.getDate() + (month - 1) * 28);
        const method = month % 2 === 0 ? "PHONEPE" : "CASH";
        await Payment.create({
          customerId: customer._id,
          schemeId: enrollment._id,
          amountPaise: INSTALLMENT_PAISE,
          method,
          status: "SUCCESS",
          paymentDate,
          schemeMonth: month,
          receiptNumber: `${opts.receiptPrefix}-${month}`,
          merchantTransactionId:
            method === "PHONEPE" ? `${opts.receiptPrefix}-MTX-${month}` : undefined,
          collectorRole: method === "CASH" ? "ADMIN" : "CUSTOMER",
          collectedBy: method === "CASH" ? admin._id : customerUser._id,
          goldRateId: goldRate._id,
          goldRatePerGramPaise: ratePaise,
          goldPurity: "916",
          goldWeightMg: weightPerPayment,
          createdBy: admin._id,
          createdAt: paymentDate,
          updatedAt: paymentDate,
        });
        paymentsCreated += 1;
      }

      if (opts.status === "REDEEMED") {
        await Payout.create({
          customerId: customer._id,
          schemeId: enrollment._id,
          amountPaise: opts.monthsPaid * INSTALLMENT_PAISE,
          goldWeightMg: opts.monthsPaid * weightPerPayment,
          makingChargeWaiverPercent: 100,
          gstRateBasisPoints: 300,
          payoutType: "REDEEM",
          method: "GOLD",
          payoutDate: daysAgo(3),
          referenceNumber: `PAG-PO-${opts.enrollmentNumber}`,
          notes: "Pagination seed redemption",
          status: "SUCCESS",
          createdBy: admin._id,
        });
        payoutsCreated += 1;
      }

      return enrollment;
    };

    if (isMobileTestCustomer) {
      // 11 + 11 + 5 = 27 SUCCESS payments — enough for mobile payment-list pagination.
      // Only one ACTIVE enrollment allowed per customer.
      await createEnrollmentWithPayments({
        enrollmentNumber: `${PAGINATION_ENROLLMENT_PREFIX}0001-A`,
        start: daysAgo(900),
        status: "REDEEMED",
        monthsPaid: 11,
        receiptPrefix: "PAG-RCPT-1A",
      });
      await createEnrollmentWithPayments({
        enrollmentNumber: `${PAGINATION_ENROLLMENT_PREFIX}0001-B`,
        start: daysAgo(520),
        status: "CLOSED",
        monthsPaid: 11,
        receiptPrefix: "PAG-RCPT-1B",
      });
      await createEnrollmentWithPayments({
        enrollmentNumber: `${PAGINATION_ENROLLMENT_PREFIX}0001`,
        start: daysAgo(150),
        status: "ACTIVE",
        monthsPaid: 5,
        receiptPrefix: "PAG-RCPT-1C",
      });
      enrolled += 2; // two extra historical enrollments
      continue;
    }

    const status = isRedeemed ? "REDEEMED" : isMatured ? "MATURED" : "ACTIVE";
    const monthsPaid = isRedeemed || isMatured ? 11 : Math.min(4, 1 + (i % 4));
    const start = daysAgo(60 + (i % 20));

    await createEnrollmentWithPayments({
      enrollmentNumber: `${PAGINATION_ENROLLMENT_PREFIX}${String(i).padStart(4, "0")}`,
      start,
      status,
      monthsPaid,
      receiptPrefix: `PAG-RCPT-${i}`,
    });

    // Pending intents on a few active enrollments (payments list / detail).
    if (status === "ACTIVE" && i % 5 === 0 && monthsPaid < 11) {
      const nextMonth = monthsPaid + 1;
      const enrollment = await SchemeEnrollment.findOne({
        enrollmentNumber: `${PAGINATION_ENROLLMENT_PREFIX}${String(i).padStart(4, "0")}`,
      }).lean();
      if (enrollment) {
        await PaymentIntent.create({
          customerId: customer._id,
          schemeId: enrollment._id,
          amountPaise: INSTALLMENT_PAISE,
          merchantTransactionId: `PAG-INTENT-${i}-${nextMonth}`,
          provider: "PHONEPE",
          checkoutChannel: "WEB",
          status: "PENDING",
          idempotencyKey: `pag-idem-${i}-${nextMonth}`,
          idempotencyScope: "PHONEPE_CUSTOMER_WEB",
          requestHash: `pag-hash-${i}-${nextMonth}`,
          goldRateId: goldRate._id,
          goldRatePerGramPaise: ratePaise,
          goldWeightMg: weightPerPayment,
          goldPurity: "916",
          schemeMonth: nextMonth,
          collectorRole: "CUSTOMER",
          createdBy: customerUser._id,
          nextStatusCheckAt: new Date(Date.now() + 60_000),
        });
        intentsCreated += 1;
      }
    }
  }

  const maxCode = PAGINATION_CODE_BASE + count;
  await ReceiptCounter.findOneAndUpdate(
    { scope: PASSBOOK_SCOPE },
    { $max: { value: maxCode } },
    { upsert: true },
  );

  return {
    customers: count,
    inactive,
    enrolled,
    paymentsCreated,
    intentsCreated,
    payoutsCreated,
    adminPhone: ADMIN_PHONE,
    sampleCustomerPhone: paginationPhone(1),
    mobileTestPayments: 27,
    mobileTestNextMonth: 6,
    password: DEMO_PASSWORD,
    pageSizeHint: 10,
    expectedCustomerPages: Math.ceil(count / 10),
  };
}
