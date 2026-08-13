import { AppError } from './AppError.js';
export type Paise = number & { readonly __brand: 'Paise' };
export const paise = (value: number): Paise => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError('INVALID_MONEY', 'Money must be a non-negative safe integer in paise', 422);
  return value as Paise;
};
export const rupeesToPaise = (value: string): Paise => {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new AppError('INVALID_MONEY', 'Invalid rupee value', 422);
  const [whole = '0', decimal = ''] = value.split('.');
  return paise(Number(whole) * 100 + Number(decimal.padEnd(2, '0')));
};
export const paiseToRupees = (value: number) => (paise(value) / 100).toFixed(2);
export const addMoney = (a: number, b: number) => paise(paise(a) + paise(b));
export const subtractMoney = (a: number, b: number) => {
  if (b > a) throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient balance', 409);
  return paise(a - b);
};
export const compareMoney = (a: number, b: number) => Math.sign(paise(a) - paise(b));
export const formatCurrency = (value: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise(value) / 100);

/** Parse external/gateway numeric amounts into validated paise. */
export const paiseFromUnknown = (value: unknown, label = 'Amount'): Paise => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new AppError('INVALID_MONEY', `${label} must be a non-negative integer in paise`, 422);
  }
  return paise(numeric);
};
