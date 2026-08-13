import { z } from 'zod';
import { INDIAN_MOBILE_REGEX, normalizeIndianPhone } from '../utils/phone.js';

export const indianPhoneSchema = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeIndianPhone(value) : value),
  z.string().regex(INDIAN_MOBILE_REGEX, 'Invalid phone number'),
);

export const optionalIndianPhoneSchema = z.preprocess(
  (value) => {
    if (value == null || value === '') return undefined;
    return typeof value === 'string' ? normalizeIndianPhone(value) : value;
  },
  z.string().regex(INDIAN_MOBILE_REGEX, 'Invalid phone number').optional(),
);
