import mongoose from 'mongoose';
import { OutboxEvent, Payment, SchemeEnrollment } from '../models/index.js';
import { logger } from '../config/logger.js';
import { buildInstallmentSchedule } from '../services/installment-schedule.service.js';
import { schemeMonth } from '../utils/time.js';

export const SCHEME_REMINDER_INTERVAL_MS = 60_000;
const SCAN_BATCH = 50;

let timer: NodeJS.Timeout | undefined;
let running = false;

function reminderDedupeKey(enrollmentId: unknown, schemeMonthNumber: number, status: 'DUE' | 'OVERDUE') {
  return `installment:${String(enrollmentId)}:${schemeMonthNumber}:${status}`;
}

export async function processSchemeReminderBatch(now = new Date()) {
  let created = 0;
  let scanned = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  while (true) {
    const filter: Record<string, unknown> = { status: 'ACTIVE' };
    if (lastId) filter._id = mongoose.trusted({ $gt: lastId });
    const batch = await SchemeEnrollment.find(filter)
      .sort({ _id: 1 })
      .limit(SCAN_BATCH)
      .select(
        '_id customerId startDate durationMonths monthlyInstallmentPaise status paymentWindowType fixedPaymentDay paymentWindowStartDay paymentWindowEndDay planSnapshot',
      )
      .lean();
    if (!batch.length) break;
    lastId = batch[batch.length - 1]._id;
    scanned += batch.length;

    const payments = await Payment.find(
      mongoose.trusted({
        schemeId: mongoose.trusted({ $in: batch.map((row: { _id: unknown }) => row._id) }),
        status: 'SUCCESS',
      }),
    )
      .select('schemeId schemeMonth status')
      .lean();
    const paymentsByScheme = new Map<string, typeof payments>();
    for (const payment of payments) {
      const key = String(payment.schemeId);
      paymentsByScheme.set(key, [...(paymentsByScheme.get(key) ?? []), payment]);
    }

    for (const enrollment of batch) {
      if (schemeMonth(enrollment.startDate, now) > 11) continue;
      const schedule = buildInstallmentSchedule(
        enrollment,
        paymentsByScheme.get(String(enrollment._id)) ?? [],
        now,
      );
      for (const item of schedule) {
        if (item.status !== 'DUE' && item.status !== 'OVERDUE') continue;
        const type = item.status === 'DUE' ? 'INSTALLMENT_DUE' : 'INSTALLMENT_OVERDUE';
        const dedupeKey = reminderDedupeKey(enrollment._id, item.schemeMonth, item.status);
        try {
          await OutboxEvent.create([
            {
              type,
              aggregateType: 'SchemeEnrollment',
              aggregateId: enrollment._id,
              dedupeKey,
              payload: {
                customerId: enrollment.customerId,
                enrollmentId: String(enrollment._id),
                schemeMonth: item.schemeMonth,
                amountPaise: item.amountPaise,
                dueDate: item.dueDate,
                paymentWindowEndDate: item.paymentWindowEndDate,
              },
            },
          ]);
          created += 1;
        } catch (error: any) {
          if (error?.code !== 11000) throw error;
        }
      }
    }
    if (batch.length < SCAN_BATCH) break;
  }

  return { scanned, created };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await processSchemeReminderBatch();
    if (result.created) logger.info(result, 'scheme reminder batch completed');
  } catch (error) {
    logger.error({ err: error }, 'scheme reminder worker failed');
  } finally {
    running = false;
  }
}

export function startSchemeReminderWorker() {
  if (timer) return;
  timer = setInterval(() => void tick(), SCHEME_REMINDER_INTERVAL_MS);
  timer.unref();
  void tick();
}

export function stopSchemeReminderWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
