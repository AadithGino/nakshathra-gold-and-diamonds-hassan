import { describe, expect, it } from 'vitest';
import { phonePeProvider } from '../src/services/phonepe.provider.js';

describe('PhonePe refund field mapping', () => {
  it('maps top-level rail.type and upiTransactionId as bank reference', () => {
    const mapped = (phonePeProvider as any).toRefundStatus({
      state: 'COMPLETED',
      amount: 100_000,
      refundId: 'REF-TOP-1',
      transactionId: 'PP-TXN-SHOULD-NOT-BE-UTR',
      rail: {
        type: 'UPI',
        upiTransactionId: 'UPI-1234567890',
      },
    });

    expect(mapped.state).toBe('SUCCESS');
    expect(mapped.providerRefundId).toBe('REF-TOP-1');
    expect(mapped.railType).toBe('UPI');
    expect(mapped.bankReferenceId).toBe('UPI-1234567890');
    expect(mapped.bankReferenceId).not.toBe('PP-TXN-SHOULD-NOT-BE-UTR');
    expect(mapped.raw._mapped.providerTransactionId).toBe('PP-TXN-SHOULD-NOT-BE-UTR');
  });

  it('maps rail.utr when present', () => {
    const mapped = (phonePeProvider as any).toRefundStatus({
      state: 'SUCCESS',
      amount: 50_000,
      refundId: 'REF-UTR-1',
      rail: { type: 'UPI', utr: 'UTR9876543210' },
    });
    expect(mapped.bankReferenceId).toBe('UTR9876543210');
    expect(mapped.railType).toBe('UPI');
  });

  it('supports SDK-style paymentDetails rail without treating transactionId as bank UTR', () => {
    const mapped = (phonePeProvider as any).toRefundStatus({
      state: 'COMPLETED',
      refundAmount: 100_000,
      refundId: 'REF-SDK-1',
      paymentDetails: [
        {
          transactionId: 'PP-DETAIL-TXN',
          rail: {
            type: 'UPI',
            upiTransactionId: 'UPI-FROM-DETAIL',
          },
        },
      ],
    });
    expect(mapped.railType).toBe('UPI');
    expect(mapped.bankReferenceId).toBe('UPI-FROM-DETAIL');
    expect(mapped.raw._mapped.providerTransactionId).toBe('PP-DETAIL-TXN');
  });
});
