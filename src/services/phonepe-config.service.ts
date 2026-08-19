import { env } from '../config/env.js';
import type { Role } from '../models/index.js';
import { SystemSetting } from '../models/index.js';

export type PhonePeClientCredentials = {
  enabled: boolean;
  environment: 'SANDBOX' | 'PRODUCTION';
  clientId: string;
  clientSecret: string;
  clientVersion: number;
  /** PhonePe SDK init expects merchantId — same as clientId for this integration. */
  merchantId: string;
  redirectUrl: string;
};

async function isPhonePeEnabledForRole(role: Role) {
  if (!env.PHONEPE_ENABLED) return false;
  if (role !== 'CUSTOMER') return true;
  const settings = await SystemSetting.findOne({ singletonKey: 'GLOBAL' })
    .select('customerPhonePeEnabled')
    .lean();
  return settings?.customerPhonePeEnabled !== false;
}

export async function getPhonePeClientCredentials(role: Role): Promise<PhonePeClientCredentials> {
  const enabled = await isPhonePeEnabledForRole(role);
  return {
    enabled,
    environment: env.PHONEPE_ENV,
    clientId: enabled ? env.PHONEPE_CLIENT_ID : '',
    clientSecret: enabled ? env.PHONEPE_CLIENT_SECRET : '',
    clientVersion: env.PHONEPE_CLIENT_VERSION,
    merchantId: enabled ? env.PHONEPE_CLIENT_ID : '',
    redirectUrl: env.PHONEPE_REDIRECT_URL,
  };
}
