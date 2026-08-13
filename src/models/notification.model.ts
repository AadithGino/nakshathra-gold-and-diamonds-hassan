import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';

const notificationSchema = createSchema({
  userId: { ...objectIdField('User'), index: true },
  type: String,
  title: String,
  body: String,
  readAt: Date,
  data: Schema.Types.Mixed,
  outboxEventId: objectIdField('OutboxEvent', false),
});

notificationSchema.index({ outboxEventId: 1 }, { unique: true, sparse: true });

export const Notification = registerModel('Notification', notificationSchema);
