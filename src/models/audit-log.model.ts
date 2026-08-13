import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import { ROLES } from './enums.js';

const auditLogSchema = createSchema(
  {
    actorId: objectIdField('User', false),
    actorRole: { type: String, enum: ROLES },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: Schema.Types.ObjectId,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    requestId: String,
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog = registerModel('AuditLog', auditLogSchema);
