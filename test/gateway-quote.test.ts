import { describe, expect, it } from 'vitest';
import { gatewayGoldFromIntent } from '../src/services/payment.service.js';

describe('gateway quote locking', () => {
  it('uses the locked gold snapshot from the payment intent', () => {
    expect(
      gatewayGoldFromIntent(
        {
          goldRateId: 'rate-id',
          goldRatePerGramPaise: 750_000,
          goldWeightMg: 133,
          goldPurity: '916',
        },
        'GOLD_WEIGHT',
      ),
    ).toEqual({
      goldRateId: 'rate-id',
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
    });
  });

  it('requires a complete gold quote for gold schemes', () => {
    expect(() =>
      gatewayGoldFromIntent({ goldRatePerGramPaise: 750_000 }, 'GOLD_WEIGHT'),
    ).toThrow(/missing the locked gold quote/i);
  });

  it('skips gold fields for cash schemes', () => {
    expect(gatewayGoldFromIntent({}, 'CASH')).toEqual({});
  });
});
