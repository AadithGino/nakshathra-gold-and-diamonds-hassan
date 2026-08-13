import mongoose from 'mongoose';

/** Events claimable by the outbox worker: fresh PENDING or lease-expired / legacy PROCESSING. */
export const claimableOutboxFilter = (at: Date) =>
  mongoose.trusted({
    $or: [
      {
        status: 'PENDING',
        availableAt: mongoose.trusted({ $lte: at }),
      },
      {
        status: 'PROCESSING',
        lockUntil: mongoose.trusted({ $lt: at }),
      },
      // Legacy worker records may have never set a lease.
      {
        status: 'PROCESSING',
        lockUntil: null,
      },
      {
        status: 'PROCESSING',
        lockUntil: mongoose.trusted({ $exists: false }),
      },
    ],
  });

/** Pending / uncertain PhonePe intents due for recovery status polling. */
export const claimablePaymentRecoveryFilter = (at: Date) =>
  mongoose.trusted({
    status: mongoose.trusted({ $in: ['PENDING', 'PROVIDER_CREATE_UNCERTAIN'] }),
    nextStatusCheckAt: mongoose.trusted({ $lte: at }),
    $or: [
      { recoveryLockUntil: null },
      { recoveryLockUntil: mongoose.trusted({ $exists: false }) },
      { recoveryLockUntil: mongoose.trusted({ $lt: at }) },
    ],
  });

/** Stale PROVIDER_CREATING leases that must become uncertain before any create retry. */
export const staleProviderCreatingFilter = (at: Date) =>
  mongoose.trusted({
    status: 'PROVIDER_CREATING',
    $or: [
      { providerLaunchLockUntil: null },
      { providerLaunchLockUntil: mongoose.trusted({ $exists: false }) },
      { providerLaunchLockUntil: mongoose.trusted({ $lte: at }) },
    ],
  });

/** Active app-initiated refunds due for provider status polling. */
export const claimableRefundRecoveryFilter = (at: Date) =>
  mongoose.trusted({
    status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
    active: true,
    nextStatusCheckAt: mongoose.trusted({ $lte: at }),
    $or: [
      { recoveryLockUntil: null },
      { recoveryLockUntil: mongoose.trusted({ $exists: false }) },
      { recoveryLockUntil: mongoose.trusted({ $lt: at }) },
    ],
  });

/** Legacy active refunds that never received a recovery schedule (crash window). */
export const legacyUnscheduledActiveRefundFilter = () =>
  mongoose.trusted({
    status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
    active: true,
    $or: [
      { nextStatusCheckAt: null },
      { nextStatusCheckAt: mongoose.trusted({ $exists: false }) },
    ],
  });
