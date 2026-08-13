import { createSchema, objectIdField, registerModel } from './model-helpers.js';

const staffProfileSchema = createSchema({
  userId: objectIdField('User'),
  employeeCode: { type: String, required: true },
  permissions: [{ type: String }],
  notes: String,
  cashVersion: { type: Number, default: 0 },
  createdBy: objectIdField('User', false),
  updatedBy: objectIdField('User', false),
});

staffProfileSchema.index({ userId: 1 }, { unique: true, name: 'STAFF_PROFILE_USER_UNIQUE' });
staffProfileSchema.index(
  { employeeCode: 1 },
  { unique: true, name: 'STAFF_EMPLOYEE_CODE_UNIQUE' },
);

export const StaffProfile = registerModel('StaffProfile', staffProfileSchema);
