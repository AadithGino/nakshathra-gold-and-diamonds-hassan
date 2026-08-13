import type { ClientSession } from 'mongoose';
import { Customer, User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';

function bothAadhaarKeys(aadhaar?: { frontKey?: string | null; backKey?: string | null } | null) {
  return Boolean(aadhaar?.frontKey && aadhaar?.backKey);
}

export async function assertCustomerCanStartFinancialActivity(
  customerId: string,
  session?: ClientSession,
) {
  const customer = await Customer.findById(customerId).session(session ?? null);
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
  const user = await User.findById(customer.userId).session(session ?? null);
  if (!user) throw new AppError('USER_NOT_FOUND', 'Customer login account not found', 404);

  if (customer.status !== 'ACTIVE' || user.status !== 'ACTIVE') {
    throw new AppError(
      'CUSTOMER_INACTIVE',
      'Inactive customers cannot start new inbound financial activity',
      409,
    );
  }
  if (customer.kycStatus !== 'VERIFIED') {
    throw new AppError(
      'KYC_VERIFICATION_REQUIRED',
      'KYC must be verified before this action',
      409,
    );
  }
  return customer;
}

export async function assertCustomerKycVerified(customerId: string, session?: ClientSession) {
  const customer = await Customer.findById(customerId).session(session ?? null);
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
  if (customer.kycStatus !== 'VERIFIED') {
    throw new AppError(
      'KYC_VERIFICATION_REQUIRED',
      'KYC must be verified before this action',
      409,
    );
  }
  return customer;
}

export function initialKycFromAadhaar(aadhaar?: { frontKey?: string; backKey?: string }) {
  if (bothAadhaarKeys(aadhaar)) {
    return { kycStatus: 'PENDING' as const, kycSubmittedAt: new Date() };
  }
  return { kycStatus: 'NOT_SUBMITTED' as const };
}

/** Returns true when KYC status changed because Aadhaar documents changed. */
export function applyAadhaarKycTransition(
  customer: {
    kycStatus?: string;
    kycSubmittedAt?: Date;
    kycReviewedAt?: Date;
    kycReviewedBy?: unknown;
    kycRejectionReason?: string;
    aadhaar?: { frontKey?: string; backKey?: string };
  },
  previousFront?: string,
  previousBack?: string,
) {
  const front = customer.aadhaar?.frontKey;
  const back = customer.aadhaar?.backKey;
  const docsChanged = front !== previousFront || back !== previousBack;
  if (!docsChanged) return false;

  if (!bothAadhaarKeys(customer.aadhaar)) {
    if (customer.kycStatus === 'VERIFIED' || customer.kycStatus === 'PENDING') {
      customer.kycStatus = 'NOT_SUBMITTED';
      customer.kycReviewedAt = undefined;
      customer.kycReviewedBy = undefined;
      customer.kycRejectionReason = undefined;
      return true;
    }
    return false;
  }

  if (
    customer.kycStatus === 'NOT_SUBMITTED' ||
    customer.kycStatus === 'REJECTED' ||
    customer.kycStatus === 'VERIFIED'
  ) {
    customer.kycStatus = 'PENDING';
    customer.kycSubmittedAt = new Date();
    customer.kycRejectionReason = undefined;
    customer.kycReviewedAt = undefined;
    customer.kycReviewedBy = undefined;
    return true;
  }

  if (customer.kycStatus === 'PENDING') {
    customer.kycSubmittedAt = new Date();
    return true;
  }

  return false;
}
