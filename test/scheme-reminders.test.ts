import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Customer,
  Notification,
  OutboxEvent,
  Payment,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { processSchemeReminderBatch } from '../src/workers/scheme-reminder.worker.js';
import { deliverOutboxNotification } from '../src/workers/outbox.worker.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

let seq = 0;
function phone() {
  seq += 1;
  return `+917720${String(seq).padStart(6, '0')}`;
}

async function seedEnrollment(status: 'ACTIVE' | 'CLOSED' = 'ACTIVE', paidMonths: number[] = []) {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Reminder Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: 'Reminder Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-REM-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  const startDate = new Date('2026-01-01T00:00:00+05:30');
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-REM-${suffix}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: 500_000,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      paymentWindowType: 'FIXED_DAY',
      fixedPaymentDay: 5,
      status,
      createdBy: actor._id,
    },
  ]);
  for (const month of paidMonths) {
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 500_000,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: startDate,
        schemeMonth: month,
        receiptNumber: `KRL-REM-${suffix}-${month}`,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  return { actor, customer, customerUser, enrollment };
}

describe('scheme installment reminders', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('creates one DUE and one OVERDUE outbox event and does not duplicate', async () => {
    await seedEnrollment('ACTIVE', [1]);
    const at = new Date('2026-03-05T12:00:00+05:30');
    const first = await processSchemeReminderBatch(at);
    expect(first.created).toBeGreaterThanOrEqual(2);
    const due = await OutboxEvent.find({ type: 'INSTALLMENT_DUE' });
    const overdue = await OutboxEvent.find({ type: 'INSTALLMENT_OVERDUE' });
    expect(due).toHaveLength(1);
    expect(overdue.length).toBeGreaterThanOrEqual(1);
    const second = await processSchemeReminderBatch(at);
    expect(second.created).toBe(0);
    expect(await OutboxEvent.countDocuments({ type: 'INSTALLMENT_DUE' })).toBe(1);

    await Promise.all([
      processSchemeReminderBatch(at),
      processSchemeReminderBatch(at),
    ]);
    expect(await OutboxEvent.countDocuments({ type: 'INSTALLMENT_DUE' })).toBe(1);
  });

  it('skips paid installments and terminal enrollments', async () => {
    await seedEnrollment('ACTIVE', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await seedEnrollment('CLOSED', []);
    const at = new Date('2026-03-05T12:00:00+05:30');
    const result = await processSchemeReminderBatch(at);
    expect(result.created).toBe(0);
  });

  it('renders installment notification copy without sensitive fields', async () => {
    const { customerUser, enrollment } = await seedEnrollment('ACTIVE', []);
    const [event] = await OutboxEvent.create([
      {
        type: 'INSTALLMENT_DUE',
        aggregateType: 'SchemeEnrollment',
        aggregateId: enrollment._id,
        dedupeKey: `installment:${enrollment._id}:5:DUE`,
        payload: {
          customerId: enrollment.customerId,
          enrollmentId: String(enrollment._id),
          schemeMonth: 5,
          amountPaise: 500_000,
          dueDate: new Date('2026-05-05T00:00:00+05:30'),
        },
      },
    ]);
    await deliverOutboxNotification(event.toObject());
    const notification = await Notification.findOne({ outboxEventId: event._id });
    expect(notification?.userId.toString()).toBe(String(customerUser._id));
    expect(notification?.title).toBe('Scheme installment due');
    expect(notification?.body).toContain('month 5');
    expect(notification?.body).toContain('5,000');
    expect(JSON.stringify(notification?.data)).not.toMatch(/aadhaar/i);
  });
});
