import { z } from 'zod';

/** Zod helper — integer money/weight values that are safe in JavaScript. */
export const safeInt = (label = 'Value') =>
  z
    .number()
    .int(`${label} must be a whole number`)
    .refine(Number.isSafeInteger, `${label} exceeds safe integer range`);

export const paiseAmount = () => safeInt('Amount').positive();
export const goldWeightAmount = () => safeInt('Gold weight').min(0);
