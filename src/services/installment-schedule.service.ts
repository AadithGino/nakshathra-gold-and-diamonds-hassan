import {
  addMonths,
  differenceInCalendarDays,
  endOfDay,
  endOfMonth,
  isAfter,
  isBefore,
  startOfDay,
  startOfMonth,
} from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { BUSINESS_TZ, schemeMonth } from '../utils/time.js';
import { clampDayOfMonth, resolvePaymentWindow } from '../utils/payment-window.js';

export type InstallmentStatus = 'PAID' | 'DUE' | 'OVERDUE' | 'UPCOMING';

type EnrollmentLike = {
  _id?: unknown;
  startDate: Date | string;
  durationMonths?: number;
  monthlyInstallmentPaise: number;
  status: string;
  paymentWindowType?: string;
  fixedPaymentDay?: number;
  paymentWindowStartDay?: number;
  paymentWindowEndDay?: number;
  planSnapshot?: {
    paymentWindowType?: string;
    fixedPaymentDay?: number;
    paymentWindowStartDay?: number;
    paymentWindowEndDay?: number;
  } | null;
};

type PaymentLike = {
  _id?: unknown;
  schemeMonth?: number;
  status: string;
  paymentDate?: Date | string;
  amountPaise?: number;
  receiptNumber?: string;
  method?: string;
  goldWeightMg?: number;
  goldRatePerGramPaise?: number;
};

export type InstallmentScheduleItem = {
  schemeMonth: number;
  amountPaise: number;
  dueDate: Date;
  periodStartDate: Date;
  periodEndDate: Date;
  paymentWindowStartDate: Date;
  paymentWindowEndDate: Date;
  status: InstallmentStatus;
  daysOverdue: number;
  canRecord: boolean;
  payment: null | {
    paymentId: string | null;
    paymentDate: Date | string | undefined;
    amountPaise: number | undefined;
    receiptNumber: string | undefined;
    method: string | undefined;
    goldWeightMg: number | undefined;
    goldRatePerGramPaise: number | undefined;
  };
};

function wallDate(year: number, monthIndex0: number, day: number, hours = 0, minutes = 0, seconds = 0) {
  return new Date(year, monthIndex0, day, hours, minutes, seconds, 0);
}

export function buildInstallmentSchedule(
  enrollment: EnrollmentLike,
  payments: PaymentLike[],
  at = new Date(),
): InstallmentScheduleItem[] {
  const durationMonths = Math.min(11, Math.max(0, enrollment.durationMonths ?? 11));
  const localStart = toZonedTime(new Date(enrollment.startDate), BUSINESS_TZ);
  const localNow = toZonedTime(at, BUSINESS_TZ);
  const activeSchemeMonth = schemeMonth(new Date(enrollment.startDate), at);
  const window = resolvePaymentWindow(enrollment);
  const successfulByMonth = new Map<number, PaymentLike>();

  for (const payment of payments) {
    if (
      payment.status === 'SUCCESS' &&
      payment.schemeMonth &&
      !successfulByMonth.has(payment.schemeMonth)
    ) {
      successfulByMonth.set(payment.schemeMonth, payment);
    }
  }

  return Array.from({ length: durationMonths }, (_, index) => {
    const month = index + 1;
    const periodStartLocal = startOfMonth(addMonths(localStart, index));
    const periodEndLocal = endOfMonth(periodStartLocal);
    const year = periodStartLocal.getFullYear();
    const monthIndex0 = periodStartLocal.getMonth();
    const startDay =
      window.paymentWindowType === 'DATE_RANGE'
        ? (window.paymentWindowStartDay ?? 1)
        : (window.fixedPaymentDay ?? 5);
    const endDay =
      window.paymentWindowType === 'DATE_RANGE'
        ? (window.paymentWindowEndDay ?? startDay)
        : startDay;
    const windowStartLocal = startOfDay(
      wallDate(year, monthIndex0, clampDayOfMonth(year, monthIndex0, startDay)),
    );
    const windowEndLocal = endOfDay(
      wallDate(year, monthIndex0, clampDayOfMonth(year, monthIndex0, endDay)),
    );
    const dueLocal = window.paymentWindowType === 'DATE_RANGE' ? windowEndLocal : windowStartLocal;
    const payment = successfulByMonth.get(month);

    let status: InstallmentStatus;
    if (payment) {
      status = 'PAID';
    } else if (isBefore(localNow, localStart) || isAfter(startOfDay(periodStartLocal), localNow)) {
      status = 'UPCOMING';
    } else if (isBefore(localNow, windowStartLocal)) {
      status = 'UPCOMING';
    } else if (!isAfter(localNow, windowEndLocal)) {
      status = 'DUE';
    } else {
      status = 'OVERDUE';
    }

    const daysOverdue =
      status === 'OVERDUE' ? Math.max(0, differenceInCalendarDays(localNow, windowEndLocal)) : 0;

    const canRecord =
      enrollment.status === 'ACTIVE' &&
      !payment &&
      month >= 1 &&
      month <= durationMonths &&
      activeSchemeMonth <= durationMonths;

    return {
      schemeMonth: month,
      amountPaise: Number(enrollment.monthlyInstallmentPaise),
      dueDate: fromZonedTime(dueLocal, BUSINESS_TZ),
      periodStartDate: fromZonedTime(periodStartLocal, BUSINESS_TZ),
      periodEndDate: fromZonedTime(periodEndLocal, BUSINESS_TZ),
      paymentWindowStartDate: fromZonedTime(windowStartLocal, BUSINESS_TZ),
      paymentWindowEndDate: fromZonedTime(windowEndLocal, BUSINESS_TZ),
      status,
      daysOverdue,
      canRecord,
      payment: payment
        ? {
            paymentId: payment._id ? String(payment._id) : null,
            paymentDate: payment.paymentDate,
            amountPaise: payment.amountPaise,
            receiptNumber: payment.receiptNumber,
            method: payment.method,
            goldWeightMg: payment.goldWeightMg,
            goldRatePerGramPaise: payment.goldRatePerGramPaise,
          }
        : null,
    };
  });
}

export function summarizeInstallmentSchedule(schedule: InstallmentScheduleItem[]) {
  const counts = {
    paid: schedule.filter((item) => item.status === 'PAID').length,
    due: schedule.filter((item) => item.status === 'DUE').length,
    overdue: schedule.filter((item) => item.status === 'OVERDUE').length,
    upcoming: schedule.filter((item) => item.status === 'UPCOMING').length,
  };
  const nextInstallment =
    schedule.find((item) => item.status === 'OVERDUE') ??
    schedule.find((item) => item.status === 'DUE') ??
    schedule.find((item) => item.status === 'UPCOMING') ??
    null;

  return {
    ...counts,
    total: schedule.length,
    remaining: schedule.length - counts.paid,
    nextInstallment,
  };
}
