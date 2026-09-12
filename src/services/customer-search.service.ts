import mongoose from 'mongoose';
import { Customer, Payment, SchemeEnrollment, User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex } from '../utils/regex.js';
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
import { withEnrollmentContract } from '../utils/scheme-contract.js';
import { getPaymentRules } from './scheme.service.js';
import {
  buildContributionStatus,
  buildSchemeSummaryFromEnrollment,
} from './contribution-status.service.js';

const RECENT_PAYMENT_LIMIT = 25;

export async function searchCustomers(
  search: string,
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const users = search
    ? await User.find({
        $or: [{ name: new RegExp(escapeRegex(search), 'i') }, { phone: new RegExp(escapeRegex(search), 'i') }],
        role: 'CUSTOMER',
      })
        .select('_id')
        .lean()
    : [];
  const match = search
    ? {
        $or: [
          { customerCode: new RegExp(escapeRegex(search), 'i') },
          {
            userId: mongoose.trusted({
              $in: users.map((user: any) => user._id),
            }),
          },
        ],
      }
    : {};
  const sortField = 'createdAt';
  const filter = withKeysetFilter(match, query, sortField);
  const baseQuery = Customer.find(filter).select('-aadhaar').populate('userId', 'name phone');

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
    Customer.countDocuments(match),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

function operationalCustomer(customer: Record<string, any>) {
  const { aadhaar: _aadhaar, ...safe } = customer;
  const user = safe.userId && typeof safe.userId === 'object' ? safe.userId : null;
  return {
    profile: {
      customerId: String(safe._id),
      name: user?.name ?? null,
      phone: user?.phone ?? null,
      customerCode: safe.customerCode,
      passbookNumber: safe.customerCode,
      status: safe.status,
      kycStatus: safe.kycStatus,
    },
    customer: safe,
  };
}

export async function getCustomerFinancialView(customerId: string) {
  const [customer, schemes, recentPayments] = await Promise.all([
    Customer.findById(customerId)
      .select('-aadhaar')
      .populate('userId', 'name phone status')
      .populate('nomineeId')
      .lean(),
    SchemeEnrollment.find({ customerId })
      .populate('schemePlanId', 'name type')
      .sort({ startDate: -1, createdAt: -1 })
      .lean(),
    Payment.find({ customerId, status: 'SUCCESS' })
      .select(
        'amountPaise method status paymentDate schemeMonth receiptNumber schemeId collectedBy collectorRole notes referenceNumber',
      )
      .populate('schemeId', 'enrollmentNumber schemeType')
      .sort({ paymentDate: -1, createdAt: -1 })
      .limit(RECENT_PAYMENT_LIMIT)
      .lean(),
  ]);
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);

  const { profile, customer: safeCustomer } = operationalCustomer(customer as Record<string, any>);
  const active = schemes.find((scheme: any) => scheme.status === 'ACTIVE') ?? null;
  const activeEnrollment = active ? withEnrollmentContract(active) : null;
  const schemeSummary = buildSchemeSummaryFromEnrollment(activeEnrollment);

  let contribution = activeEnrollment
    ? await buildContributionStatus(String(activeEnrollment._id))
    : null;

  const rules = await Promise.all(
    schemes
      .filter((scheme: any) => scheme.status === 'ACTIVE')
      .map(async (scheme: any) => {
        try {
          const result = await getPaymentRules(String(scheme._id), new Date(), 0, undefined, {
            enforceLimit: false,
            requireGoldRate: false,
          });
          return {
            schemeId: scheme._id,
            schemeMonth: result.schemeMonth,
            phase: result.phase,
            phaseLabel: result.phaseLabel,
            capPaise: result.capPaise,
            paidThisMonthPaise: result.paidThisMonthPaise,
            remainingPaise: result.remainingPaise,
            minimumPaymentPaise: result.minimumPaymentPaise,
            capApplies: result.capApplies,
          };
        } catch {
          return null;
        }
      }),
  );

  return {
    profile,
    customer: safeCustomer,
    activeEnrollment,
    schemeSummary,
    contribution,
    recentPayments,
    payments: recentPayments,
    schemes,
    paymentRules: rules.filter(Boolean),
  };
}
