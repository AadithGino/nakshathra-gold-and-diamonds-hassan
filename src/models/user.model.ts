import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import { ROLES } from './enums.js';

const userSchema = createSchema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, required: true, unique: true, match: /^\+?[1-9]\d{7,14}$/ },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true, index: true },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'LOCKED'],
    default: 'ACTIVE',
    index: true,
  },
  failedLoginCount: { type: Number, default: 0, min: 0, select: false },
  lockedUntil: { type: Date, select: false },
  lastLoginAt: Date,
  sessionVersion: { type: Number, default: 0, select: false },
  createdBy: objectIdField('User', false),
  updatedBy: objectIdField('User', false),
  deletedAt: Date,
});

userSchema.index({ name: 'text', phone: 'text' });

export const User = registerModel('User', userSchema);
