import { createServer } from 'node:http';
import { app } from './src/app.js';
import { connectDatabase, disconnectDatabase } from './src/config/database.js';
import { env } from './src/config/env.js';
import { logger } from './src/config/logger.js';
import { closeSocketServer, initSocketServer } from './src/realtime/socket.js';
import { startOutboxWorker, stopOutboxWorker } from './src/workers/outbox.worker.js';
import {
  startPaymentRecoveryWorker,
  stopPaymentRecoveryWorker,
} from './src/workers/payment-recovery.worker.js';
import {
  startRefundRecoveryWorker,
  stopRefundRecoveryWorker,
} from './src/workers/refund-recovery.worker.js';
import {
  startFinancialAgingWorker,
  stopFinancialAgingWorker,
} from './src/workers/financial-aging.worker.js';
import { startSchemeReminderWorker, stopSchemeReminderWorker } from './src/workers/scheme-reminder.worker.js';

const server = createServer(app);
let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');
  stopOutboxWorker();
  stopPaymentRecoveryWorker();
  stopRefundRecoveryWorker();
  stopFinancialAgingWorker();
  stopSchemeReminderWorker();
  await closeSocketServer().catch((error) =>
    logger.error({ err: error }, 'socket server close failed'),
  );
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  server.close(async () => {
    await disconnectDatabase().catch((error) =>
      logger.error({ err: error }, 'database disconnect failed'),
    );
    clearTimeout(forceTimer);
    process.exit(exitCode);
  });
}

async function main() {
  await connectDatabase();
  initSocketServer(server);
  startOutboxWorker();
  startPaymentRecoveryWorker();
  startRefundRecoveryWorker();
  startFinancialAgingWorker();
  startSchemeReminderWorker();
  server.listen(env.PORT, '0.0.0.0', () => logger.info({ port: env.PORT }, 'API listening'));
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  logger.fatal({ err: error }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'API startup failed');
  void shutdown('startupFailure', 1);
});
