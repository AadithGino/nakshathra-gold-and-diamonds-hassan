import { addDays, addMonths, differenceInCalendarMonths, startOfDay, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
export const BUSINESS_TZ = 'Asia/Kolkata';
export const businessNow = () => toZonedTime(new Date(), BUSINESS_TZ);
/** Calendar year in Asia/Kolkata — use for receipt/enrollment identifiers. */
export const businessYear = (date: Date) => toZonedTime(date, BUSINESS_TZ).getFullYear();
export const businessDayRange = (at: Date = new Date()) => {
  const zoned = toZonedTime(at, BUSINESS_TZ);
  const startZoned = startOfDay(zoned);
  const endZoned = addDays(startZoned, 1);
  return {
    start: fromZonedTime(startZoned, BUSINESS_TZ),
    end: fromZonedTime(endZoned, BUSINESS_TZ),
  };
};
export const businessMonthRange = (at: Date = new Date(), offsetMonths = 0) => {
  const zoned = addMonths(toZonedTime(at, BUSINESS_TZ), offsetMonths);
  const startZoned = startOfMonth(zoned);
  const endZoned = addMonths(startZoned, 1);
  return {
    start: fromZonedTime(startZoned, BUSINESS_TZ),
    end: fromZonedTime(endZoned, BUSINESS_TZ),
  };
};
export const schemeMonth = (start: Date, payment: Date) =>
  differenceInCalendarMonths(
    startOfMonth(toZonedTime(payment, BUSINESS_TZ)),
    startOfMonth(toZonedTime(start, BUSINESS_TZ)),
  ) + 1;
export const maturityDate = (start: Date, months: number) =>
  fromZonedTime(addMonths(toZonedTime(start, BUSINESS_TZ), months), BUSINESS_TZ);
