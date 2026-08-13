import { createSchema, objectIdField, registerModel } from './model-helpers.js';

const systemSettingSchema = createSchema({
  singletonKey: { type: String, enum: ['GLOBAL'], default: 'GLOBAL', unique: true },
  businessName: { type: String, required: true, default: 'Nakshathra Jewellers' },
  supportPhone: { type: String, default: '' },
  supportEmail: { type: String, default: '' },
  businessAddress: { type: String, default: '' },
  receiptFooter: { type: String, default: 'Thank you for saving with Nakshathra Jewellers.' },
  customerPhonePeEnabled: { type: Boolean, default: true },
  updatedBy: objectIdField('User', false),
});

export const SystemSetting = registerModel('SystemSetting', systemSettingSchema);
