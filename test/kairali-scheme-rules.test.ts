import { describe, expect, it } from 'vitest';
import {
  enrollmentDates,
  goldWeightMg,
  resolvePaymentPhase,
} from '../src/services/scheme.service.js';
import {
  createEnrollmentSchema,
  createSchemePlanSchema,
} from '../src/validators/scheme.validators.js';
import { payoutSchema } from '../src/validators/finance.validators.js';
import {
  buildInstallmentSchedule,
  summarizeInstallmentSchedule,
} from '../src/services/installment-schedule.service.js';

describe('Kairali scheme invariants', () => {
  it('accepts payments through month 11 and reserves month 12 for redemption', () => {
    expect(
      resolvePaymentPhase(
        {
          durationMonths: 11,
          flexibleMonths: 6,
          capMonths: 5,
          capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
        },
        6,
      ).phase,
    ).toBe('FLEXIBLE');
    expect(
      resolvePaymentPhase(
        {
          durationMonths: 11,
          flexibleMonths: 6,
          capMonths: 5,
          capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
        },
        7,
      ).phase,
    ).toBe('CAPPED');
    expect(
      resolvePaymentPhase(
        {
          durationMonths: 11,
          flexibleMonths: 6,
          capMonths: 5,
          capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
        },
        11,
      ).phase,
    ).toBe('CAPPED');
    expect(resolvePaymentPhase({ durationMonths: 11 }, 12).phase).toBe('REDEMPTION');
    expect(resolvePaymentPhase({ durationMonths: 11, flexibleMonths: 11 }, 11).phase).toBe(
      'FIXED',
    );
  });

  it('opens a one-month redemption window immediately after the payment term', () => {
    const dates = enrollmentDates(
      new Date('2026-01-01T00:00:00+05:30'),
      11,
      11,
    );

    expect(dates.redemptionStartDate.toISOString()).toBe(
      '2026-11-30T18:30:00.000Z',
    );
    expect(dates.redemptionEndDate.toISOString()).toBe(
      '2026-12-31T18:30:00.000Z',
    );
  });

  it('converts the received rupee amount at the exact board rate', () => {
    expect(goldWeightMg(100_000, 750_000)).toBe(133);
  });

  it('rejects plans or enrollments below ₹1,000', () => {
    const invalidPlan = createSchemePlanSchema.safeParse({
      name: 'Nakshathra Cash Savings',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: 99_999,
      termsText: 'Eleven fixed installments and redemption in month twelve.',
    });
    const invalidEnrollment = createEnrollmentSchema.safeParse({
      customerId: 'customer-id',
      schemePlanId: 'plan-id',
      startDate: '2026-01-01',
      monthlyInstallmentPaise: 99_999,
    });

    expect(invalidPlan.success).toBe(false);
    expect(invalidEnrollment.success).toBe(false);
  });

  it('supports CASH PAYOUT and GOLD_WEIGHT REDEEM, and rejects unknown cashout types', () => {
    expect(
      payoutSchema.safeParse({
        customerId: 'customer-id',
        schemeId: 'scheme-id',
        payoutDate: '2026-12-01',
        payoutType: 'PAYOUT',
      }).success,
    ).toBe(true);
    expect(
      payoutSchema.safeParse({
        customerId: 'customer-id',
        schemeId: 'scheme-id',
        payoutDate: '2026-12-01',
        payoutType: 'REDEEM',
      }).success,
    ).toBe(true);
    expect(
      payoutSchema.safeParse({
        customerId: 'customer-id',
        schemeId: 'scheme-id',
        payoutDate: '2026-12-01',
        payoutType: 'CASHOUT',
      }).success,
    ).toBe(false);
  });

  it('builds paid, overdue, due and upcoming fixed-installment slots', () => {
    const schedule = buildInstallmentSchedule(
      {
        startDate: '2026-01-10T00:00:00+05:30',
        durationMonths: 11,
        monthlyInstallmentPaise: 100_000,
        status: 'ACTIVE',
      },
      [
        {
          _id: 'payment-one',
          schemeMonth: 1,
          status: 'SUCCESS',
          paymentDate: '2026-01-10T00:00:00+05:30',
          amountPaise: 100_000,
          receiptNumber: 'KRL-1',
        },
      ],
      new Date('2026-03-05T12:00:00+05:30'),
    );

    expect(schedule).toHaveLength(11);
    expect(schedule[0]).toMatchObject({ schemeMonth: 1, status: 'PAID', canRecord: false });
    expect(schedule[1]).toMatchObject({ schemeMonth: 2, status: 'OVERDUE', canRecord: true });
    expect(schedule[2]).toMatchObject({ schemeMonth: 3, status: 'UPCOMING', canRecord: true });
    expect(schedule[3]).toMatchObject({ schemeMonth: 4, status: 'UPCOMING', canRecord: true });
    expect(schedule[2]?.dueDate.toISOString()).toBe('2026-03-09T18:30:00.000Z');

    const summary = summarizeInstallmentSchedule(schedule);
    expect(summary).toMatchObject({
      paid: 1,
      overdue: 1,
      due: 0,
      upcoming: 9,
      remaining: 10,
    });
    expect(summary.nextInstallment?.schemeMonth).toBe(2);
  });

  it('never permits marking installments during the redemption month', () => {
    const schedule = buildInstallmentSchedule(
      {
        startDate: '2026-01-10T00:00:00+05:30',
        durationMonths: 11,
        monthlyInstallmentPaise: 100_000,
        status: 'ACTIVE',
      },
      [],
      new Date('2026-12-05T12:00:00+05:30'),
    );

    expect(schedule.every((item) => item.canRecord === false)).toBe(true);
  });
});
