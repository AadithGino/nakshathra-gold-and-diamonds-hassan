import {
  business,
  customerCodeFloorRegex,
  formatCustomerCode,
} from "../config/business.js";
import {
  buildCursorPage,
  buildOffsetPage,
  coerceBoundedListQuery,
  cursorFetchLimit,
  offsetSkip,
  type ListPageResult,
  type ListQuery,
  withKeysetFilter,
} from "../utils/cursor-pagination.js";
import mongoose, { type ClientSession } from "mongoose";
import { withMongoTransaction } from "../utils/transaction.js";
import {
  Customer,
  Nominee,
  Payment,
  PaymentIntent,
  Payout,
  ReceiptCounter,
  SchemeEnrollment,
  User,
} from "../models/index.js";
import { AppError } from "../utils/AppError.js";
import {
  duplicatePhoneConflictError,
  throwIfDuplicatePhoneKey,
} from "../utils/mongo-duplicate-key.js";
import { INDIAN_MOBILE_REGEX, normalizeIndianPhone } from "../utils/phone.js";
import { hashPassword } from "./auth.service.js";
import { audit, type AuditContext } from "./audit.service.js";
import { isOurStorageObject, signAadhaarUrls } from "./storage.service.js";
import { createEnrollmentRecord } from "./scheme-management.service.js";
import {
  applyAadhaarKycTransition,
  initialKycFromAadhaar,
} from "./customer-financial-policy.service.js";
import { withEnrollmentContract } from "../utils/scheme-contract.js";
import {
  buildContributionStatus,
  buildSchemeSummaryFromEnrollment,
} from "./contribution-status.service.js";
import { escapeRegex } from "../utils/regex.js";
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
} from "../validators/customer.validators.js";

const PASSBOOK_SCOPE = "CUSTOMER-PASSBOOK";

function assertAadhaarKeys(aadhaar?: { frontKey?: string; backKey?: string }) {
  if (!aadhaar) return;
  for (const key of [aadhaar.frontKey, aadhaar.backKey]) {
    if (key && !isOurStorageObject(key)) {
      throw new AppError(
        "INVALID_UPLOAD_KEY",
        "Aadhaar upload key is not from the configured storage bucket",
        422,
      );
    }
  }
}

async function allocatePassbookNumber(session: ClientSession) {
  const [row] = await Customer.aggregate([
    { $match: { customerCode: { $regex: customerCodeFloorRegex() } } },
    {
      $addFields: {
        n: {
          $toInt: {
            $replaceAll: {
              input: "$customerCode",
              find: business.customerPrefix,
              replacement: "",
            },
          },
        },
      },
    },
    { $group: { _id: null, max: { $max: "$n" } } },
  ]).session(session);
  const floor = Number(row?.max ?? 0);

  await ReceiptCounter.findOneAndUpdate(
    { scope: PASSBOOK_SCOPE },
    { $max: { value: floor } },
    { upsert: true, session, setDefaultsOnInsert: true },
  );

  const counter = await ReceiptCounter.findOneAndUpdate(
    { scope: PASSBOOK_SCOPE },
    { $inc: { value: 1 } },
    { new: true, session },
  );
  return formatCustomerCode(counter!.value);
}

export async function createCustomer(
  input: CreateCustomerInput,
  context: AuditContext & { actorId: string },
) {
  assertAadhaarKeys(input.aadhaar);
  // Defense in depth: routes already normalize via indianPhoneSchema.
  const phone = normalizeIndianPhone(input.phone);
  if (!INDIAN_MOBILE_REGEX.test(phone)) {
    throw new AppError("VALIDATION_ERROR", "Invalid phone number", 422, false, [
      { path: "phone", message: "Invalid phone number" },
    ]);
  }

  try {
    return await withMongoTransaction(async (session) => {
      // Application check: User.phone is the global auth identity (customer login).
      const existing = await User.findOne({ phone, deletedAt: null }).session(session);
      if (existing) throw duplicatePhoneConflictError();

      const customerCode = await allocatePassbookNumber(session);
      let user;
      try {
        [user] = await User.create(
          [
            {
              name: input.name,
              phone,
              passwordHash: await hashPassword(input.password),
              role: "CUSTOMER",
              createdBy: context.actorId,
            },
          ],
          { session },
        );
      } catch (error) {
        // Unique index wins races after the pre-check; never leak Mongo 11000.
        throwIfDuplicatePhoneKey(error);
        throw error;
      }
      const nominee = input.nominee
        ? (
            await Nominee.create(
              [{ ...input.nominee, createdBy: context.actorId }],
              { session },
            )
          )[0]
        : null;
      const kyc = initialKycFromAadhaar(input.aadhaar);
      const [customer] = await Customer.create(
        [
          {
            userId: user._id,
            customerCode,
            address: input.address,
            aadhaar: {
              frontKey: input.aadhaar?.frontKey,
              backKey: input.aadhaar?.backKey,
            },
            kycStatus: kyc.kycStatus,
            kycSubmittedAt: kyc.kycSubmittedAt,
            nomineeId: nominee?._id,
            createdBy: context.actorId,
          },
        ],
        { session },
      );
      await audit(
        session,
        context,
        "CUSTOMER_CREATED",
        "Customer",
        customer._id,
        undefined,
        customer.toObject(),
      );
      let enrollment = null;
      if (input.enrollment) {
        enrollment = await createEnrollmentRecord(
          {
            customerId: String(customer._id),
            schemePlanId: input.enrollment.schemePlanId,
            startDate: input.enrollment.startDate,
            monthlyInstallmentPaise: input.enrollment.monthlyInstallmentPaise,
          },
          context,
          session,
        );
      }
      return { customer, enrollment };
    }, context.requestId);
  } catch (error) {
    throwIfDuplicatePhoneKey(error);
    throw error;
  }
}

export async function listCustomers(
  listQuery: ListQuery,
  search: string,
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const userIds = search
    ? (
        await User.find({
          role: "CUSTOMER",
          $or: [
            { name: new RegExp(escapeRegex(search), "i") },
            { phone: new RegExp(escapeRegex(search), "i") },
          ],
        })
          .select("_id")
          .lean()
      ).map((user: any) => user._id)
    : [];
  const match = search
    ? {
        $or: [
          { customerCode: new RegExp(escapeRegex(search), "i") },
          { userId: mongoose.trusted({ $in: userIds }) },
        ],
      }
    : {};
  const sortField = "createdAt";
  const filter = withKeysetFilter(match, query, sortField);
  const baseQuery = Customer.find(filter)
    .populate("userId", "name phone status")
    .populate("nomineeId");

  if (query.mode === "cursor") {
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
    Customer.countDocuments(match),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function getCustomerDetails(customerId: string) {
  const customer = await Customer.findById(customerId)
    .populate("userId", "name phone status lastLoginAt")
    .populate("nomineeId")
    .lean();
  if (!customer)
    throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);

  const [schemes, payments, payouts, paymentIntents, aadhaar] =
    await Promise.all([
      SchemeEnrollment.find({ customerId })
        .populate("schemePlanId")
        .sort({ createdAt: -1 })
        .lean(),
      Payment.find({ customerId })
        .sort({ paymentDate: -1 })
        .limit(250)
        .populate("collectedBy", "name phone")
        .lean(),
      Payout.find({ customerId }).sort({ payoutDate: -1 }).lean(),
      PaymentIntent.find({ customerId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      signAadhaarUrls((customer as any).aadhaar),
    ]);

  const mappedSchemes = schemes.map((scheme: any) => withEnrollmentContract(scheme));
  const active = mappedSchemes.find((scheme: any) => scheme.status === "ACTIVE") ?? null;
  const contribution = active ? await buildContributionStatus(String(active._id)) : null;
  const schemeSummary = buildSchemeSummaryFromEnrollment(active);

  return {
    customer: { ...customer, aadhaar },
    schemes: mappedSchemes,
    activeEnrollment: active,
    schemeSummary,
    contribution,
    payments,
    payouts,
    paymentIntents,
  };
}

export async function updateCustomer(
  customerId: string,
  input: UpdateCustomerInput,
  context: AuditContext & { actorId: string },
) {
  assertAadhaarKeys(input.aadhaar);
  await withMongoTransaction(async (session) => {
    const customer = await Customer.findById(customerId).session(session);
    if (!customer)
      throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
    const user = await User.findById(customer.userId)
      .select("+sessionVersion")
      .session(session);
    if (!user)
      throw new AppError(
        "USER_NOT_FOUND",
        "Customer login account not found",
        404,
      );
    const before = { customer: customer.toObject(), user: user.toObject() };

    if (input.name !== undefined) user.name = input.name;
    if (input.phone !== undefined) user.phone = input.phone;
    if (input.status !== undefined) {
      customer.status = input.status;
      user.status = input.status;
      user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    }
    user.updatedBy = context.actorId;

    if (input.address !== undefined) customer.address = input.address;
    if (input.aadhaar !== undefined) {
      const previousFront = customer.get("aadhaar.frontKey");
      const previousBack = customer.get("aadhaar.backKey");
      customer.set("aadhaar", {
        frontKey: input.aadhaar.frontKey ?? previousFront,
        backKey: input.aadhaar.backKey ?? previousBack,
      });
      const kycChanged = applyAadhaarKycTransition(
        customer,
        previousFront,
        previousBack,
      );
      if (kycChanged) {
        await audit(
          session,
          context,
          "KYC_DOCUMENTS_SUBMITTED",
          "Customer",
          customer._id,
          { kycStatus: before.customer.kycStatus },
          {
            kycStatus: customer.kycStatus,
            kycSubmittedAt: customer.kycSubmittedAt,
          },
        );
      }
    }
    customer.updatedBy = context.actorId;

    if (input.nominee) {
      let nominee = customer.nomineeId
        ? await Nominee.findById(customer.nomineeId).session(session)
        : null;
      if (!nominee) {
        [nominee] = await Nominee.create(
          [{ ...input.nominee, createdBy: context.actorId }],
          {
            session,
          },
        );
        customer.nomineeId = nominee._id;
      } else {
        Object.assign(nominee, input.nominee, { updatedBy: context.actorId });
        await nominee.save({ session });
      }
    }

    await Promise.all([user.save({ session }), customer.save({ session })]);
    await audit(
      session,
      context,
      "CUSTOMER_UPDATED",
      "Customer",
      customer._id,
      before,
      {
        customer: customer.toObject(),
        user: user.toObject(),
      },
    );
  }, context.requestId);

  return getCustomerDetails(customerId);
}

export async function verifyCustomerKyc(
  customerId: string,
  context: AuditContext & { actorId: string },
) {
  await withMongoTransaction(async (session) => {
    const customer = await Customer.findById(customerId).session(session);
    if (!customer)
      throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
    const front = customer.get("aadhaar.frontKey");
    const back = customer.get("aadhaar.backKey");
    if (!front || !back) {
      throw new AppError(
        "KYC_DOCUMENTS_REQUIRED",
        "Aadhaar front and back documents are required before verification",
        422,
      );
    }
    if (customer.kycStatus !== "PENDING") {
      throw new AppError(
        "KYC_NOT_PENDING",
        "KYC can be verified only while documents are pending review",
        409,
      );
    }
    const before = customer.toObject();
    customer.kycStatus = "VERIFIED";
    customer.kycReviewedAt = new Date();
    customer.kycReviewedBy = context.actorId;
    customer.kycRejectionReason = undefined;
    customer.updatedBy = context.actorId;
    await customer.save({ session });
    await audit(
      session,
      context,
      "KYC_VERIFIED",
      "Customer",
      customer._id,
      before,
      customer.toObject(),
    );
  }, context.requestId);
  return getCustomerDetails(customerId);
}

export async function rejectCustomerKyc(
  customerId: string,
  reason: string,
  context: AuditContext & { actorId: string },
) {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new AppError(
      "KYC_REJECTION_REASON_REQUIRED",
      "A rejection reason is required",
      422,
    );
  }
  await withMongoTransaction(async (session) => {
    const customer = await Customer.findById(customerId).session(session);
    if (!customer)
      throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
    if (customer.kycStatus !== "PENDING" && customer.kycStatus !== "VERIFIED") {
      throw new AppError(
        "KYC_NOT_REVIEWABLE",
        "KYC can be rejected only from pending or verified state",
        409,
      );
    }
    const before = customer.toObject();
    customer.kycStatus = "REJECTED";
    customer.kycReviewedAt = new Date();
    customer.kycReviewedBy = context.actorId;
    customer.kycRejectionReason = trimmed;
    customer.updatedBy = context.actorId;
    await customer.save({ session });
    await audit(
      session,
      context,
      "KYC_REJECTED",
      "Customer",
      customer._id,
      before,
      customer.toObject(),
    );
  }, context.requestId);
  return getCustomerDetails(customerId);
}
