import { createSchema, objectIdField, registerModel } from './model-helpers.js';

const refreshSessionSchema = createSchema({
  userId: objectIdField('User'),
  familyId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  issuedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: Date,
  revokedAt: Date,
  replacedBySessionId: objectIdField('RefreshSession', false),
  userAgent: String,
  ip: String,
});

refreshSessionSchema.index({ familyId: 1, revokedAt: 1 });

export const RefreshSession = registerModel('RefreshSession', refreshSessionSchema);
