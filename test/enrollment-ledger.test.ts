import { describe, expect, it } from 'vitest';
import { assertLedgerInvariants, type EnrollmentLedger } from '../src/utils/enrollment-ledger.js';

function ledger(overrides: Partial<EnrollmentLedger> = {}): EnrollmentLedger {
  const base: EnrollmentLedger = {
    totalPaidPaise: 1_100_000,
    totalGoldWeightMg: 1_463,
    totalPayoutPaise: 0,
    totalSettlementPrincipalPaise: 0,
    totalPayoutGoldWeightMg: 0,
    paymentsCompleted: 11,
    availablePaise: 1_100_000,
    availableGoldWeightMg: 1_463,
  };
  return { ...base, ...overrides };
}

describe('enrollment ledger invariants', () => {
  it('accepts a balanced ledger snapshot', () => {
    expect(() => assertLedgerInvariants(ledger(), 'scheme-id')).not.toThrow();
  });

  it('rejects payout totals above paid totals', () => {
    expect(() =>
      assertLedgerInvariants(
        ledger({
          totalSettlementPrincipalPaise: 1_200_000,
          availablePaise: 1_100_000,
        }),
        'scheme-id',
      ),
    ).toThrow(/settlement principal exceeds paid total/i);
  });

  it('rejects more than 11 paid installments', () => {
    expect(() =>
      assertLedgerInvariants(ledger({ paymentsCompleted: 12 }), 'scheme-id'),
    ).toThrow(/more than 11 paid installments/i);
  });

  it('rejects available balance mismatches', () => {
    expect(() =>
      assertLedgerInvariants(
        ledger({
          availablePaise: 999_999,
        }),
        'scheme-id',
      ),
    ).toThrow(/available paise mismatch/i);
  });
});
