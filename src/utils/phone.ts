export const INDIAN_COUNTRY_CODE = '+91';

export function stripPhoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Normalize user input to E.164 (+91XXXXXXXXXX) for Indian mobiles. */
export function normalizeIndianPhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const digits = stripPhoneDigits(trimmed);
  if (!digits) return '';

  if (digits.startsWith('91') && digits.length === 12) {
    return `+${digits}`;
  }

  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    const local = digits.slice(1);
    if (/^[6-9]/.test(local)) return `+91${local}`;
  }

  if (trimmed.startsWith('+')) {
    return `+${digits}`;
  }

  return `+91${digits}`;
}

export const INDIAN_MOBILE_REGEX = /^\+91[6-9]\d{9}$/;
