import { createSchema, objectIdField, registerModel } from './model-helpers.js';

const cashSubmissionSchema = createSchema({
  staffId: { ...objectIdField('User'), index: true },
  amountPaise: { type: Number, required: true, min: 1 },
  submissionDate: { type: Date, required: true },
  receivedBy: objectIdField('User'),
  notes: String,
  createdBy: objectIdField('User'),
  status: { type: String, enum: ['SUCCESS', 'REVERSED'], default: 'SUCCESS' },
  reversedAt: Date,
});

cashSubmissionSchema.index({ staffId: 1, status: 1 });
cashSubmissionSchema.index({ submissionDate: -1 });
cashSubmissionSchema.index(
  { staffId: 1, submissionDate: -1 },
  { name: 'CASH_SUBMISSION_STAFF_DATE' },
);

export const CashSubmission = registerModel('CashSubmission', cashSubmissionSchema);
