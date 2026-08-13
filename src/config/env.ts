import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(2020),
    MONGODB_URI: z.string().min(1),
    WEB_ORIGINS: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(480),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    COOKIE_SECURE: bool.default(false),
    BUSINESS_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    BOOTSTRAP_DEMO: bool.default(false),
    PHONEPE_ENABLED: bool.default(false),
    PHONEPE_ENV: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
    PHONEPE_CLIENT_ID: z.string().default(''),
    PHONEPE_CLIENT_SECRET: z.string().default(''),
    PHONEPE_CLIENT_VERSION: z.coerce.number().int().positive().default(1),
    PHONEPE_WEBHOOK_USERNAME: z.string().default(''),
    PHONEPE_WEBHOOK_PASSWORD: z.string().default(''),
    PHONEPE_REDIRECT_URL: z.string().url(),
    PHONEPE_DEV_AUTO_SUCCESS: bool.default(false),
    LOG_LEVEL: z.string().default('info'),
    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().default(''),
    AWS_S3_PREFIX: z.string().default('jewellers'),
    AWS_ACCESS_KEY_ID: z.string().default(''),
    AWS_SECRET_ACCESS_KEY: z.string().default(''),
    AWS_S3_SIGNED_URL_TTL: z.coerce.number().int().positive().default(3600),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10_485_760),
    JEWELLERY_ID: z.string().default('nakshathra'),
    JEWELLERY_SLUG: z.string().default('jewellery'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.PHONEPE_DEV_AUTO_SUCCESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['PHONEPE_DEV_AUTO_SUCCESS'],
        message: 'PHONEPE_DEV_AUTO_SUCCESS must be false in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.BOOTSTRAP_DEMO) {
      ctx.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_DEMO'],
        message: 'BOOTSTRAP_DEMO must be false in production',
      });
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.PHONEPE_ENABLED && env.PHONEPE_ENV !== 'PRODUCTION') {
      ctx.addIssue({
        code: 'custom',
        path: ['PHONEPE_ENV'],
        message: 'PHONEPE_ENV must be PRODUCTION when PhonePe is enabled in production',
      });
    }
    if (env.PHONEPE_ENABLED) {
      for (const key of [
        'PHONEPE_CLIENT_ID',
        'PHONEPE_CLIENT_SECRET',
        'PHONEPE_WEBHOOK_USERNAME',
        'PHONEPE_WEBHOOK_PASSWORD',
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when PhonePe is enabled`,
          });
      }
    }
  });

/** Exported for Correction A environment-guard unit tests. */
export function parseAppEnv(raw: NodeJS.ProcessEnv | Record<string, unknown>) {
  return schema.safeParse(raw);
}

const parsed = schema.safeParse(process.env);
if (!parsed.success) throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
export const env = Object.freeze({
  ...parsed.data,
  origins: parsed.data.WEB_ORIGINS.split(',').map((x) => x.trim()),
  storage: {
    region: parsed.data.AWS_REGION,
    bucket: parsed.data.AWS_S3_BUCKET,
    prefix: parsed.data.AWS_S3_PREFIX,
    accessKeyId: parsed.data.AWS_ACCESS_KEY_ID,
    secretAccessKey: parsed.data.AWS_SECRET_ACCESS_KEY,
    signedUrlTtl: parsed.data.AWS_S3_SIGNED_URL_TTL,
    maxBytes: parsed.data.MAX_UPLOAD_BYTES,
    jewelleryFolder: `${parsed.data.JEWELLERY_ID}-${parsed.data.JEWELLERY_SLUG}`,
  },
});
