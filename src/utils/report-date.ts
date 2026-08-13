import { fromZonedTime } from 'date-fns-tz';
import { AppError } from './AppError.js';
import { BUSINESS_TZ } from './time.js';

/** Parse a report `from`/`to` query as an Asia/Kolkata calendar instant. */
export function reportDate(value: unknown, endOfDay = false) {
  if (!value) return undefined;
  const raw = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      throw new AppError('VALIDATION_ERROR', 'Report date is invalid', 422);
    }
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
    return fromZonedTime(`${raw}T${time}`, BUSINESS_TZ);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('VALIDATION_ERROR', 'Report date is invalid', 422);
  }
  return parsed;
}
