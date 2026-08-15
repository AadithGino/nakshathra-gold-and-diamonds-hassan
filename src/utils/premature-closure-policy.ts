import { AppError } from './AppError.js';
import type { EnrollmentLedger } from './enrollment-ledger.js';
import { addSchemeMonths } from './time.js';
import { NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS } from '../config/business.js';

/**
 * Named Nakshathra premature-closure policy.
 * Live CASH returns contribution value with no invented penalty or gold valuation.
 * GOLD_WEIGHT remains on the existing settlement calculator.
 */
export const PREMATURE_CLOSURE_POLICY_ID = 'CONTRIBUTION_VALUE_NO_PENALTY' as const;

export { NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS };

export function prematureClosureEligibilityBoundary(startDate: Date, minElapsedMonths: number) {
  return addSchemeMonths(startDate, minElapsedMonths);
}

export function isPrematureClosureTimeEligible(
  startDate: Date,
  minElapsedMonths: number,
  at: Date,
) {
  return at.getTime() >= prematureClosureEligibilityBoundary(startDate, minElapsedMonths).getTime();
}

export type PrematureClosureSettlement = {
  policyId: typeof PREMATURE_CLOSURE_POLICY_ID;
  cashBasis: 'CONTRIBUTION_VALUE';
  amountPaise: number;
  settlementPrincipalPaise: number;
  goldWeightMg: 0;
};

export function calculatePrematureClosureSettlement(input: {
  schemeType: string;
  ledger: EnrollmentLedger;
}): PrematureClosureSettlement | null {
  if (input.schemeType !== 'CASH') return null;
  if (input.ledger.availablePaise <= 0) {
    throw new AppError(
      'INSUFFICIENT_SCHEME_BALANCE',
      'This scheme has no remaining amount available for settlement',
      409,
      false,
      [{ availablePaise: input.ledger.availablePaise }],
    );
  }
  return {
    policyId: PREMATURE_CLOSURE_POLICY_ID,
    cashBasis: 'CONTRIBUTION_VALUE',
    amountPaise: input.ledger.availablePaise,
    settlementPrincipalPaise: input.ledger.availablePaise,
    goldWeightMg: 0,
  };
}
