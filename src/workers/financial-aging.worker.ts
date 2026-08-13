import {
  ageOpenFinancialExceptions,
  syncExceptionsFromMarkers,
} from '../services/financial-exception.service.js';
import { logger } from '../config/logger.js';
import { FINANCIAL_AGING_INTERVAL_MS } from '../utils/financial-aging.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export async function processFinancialAgingBatch(now = new Date()) {
  const synced = await syncExceptionsFromMarkers(now);
  const aged = await ageOpenFinancialExceptions(now);
  return { ...synced, ...aged };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await processFinancialAgingBatch();
    if (result.created || result.updated || result.alerted) {
      logger.info(result, 'financial aging batch completed');
    }
  } catch (error) {
    logger.error({ err: error }, 'financial aging worker failed');
  } finally {
    running = false;
  }
}

export function startFinancialAgingWorker() {
  if (timer) return;
  timer = setInterval(() => void tick(), FINANCIAL_AGING_INTERVAL_MS);
  timer.unref();
  void tick();
}

export function stopFinancialAgingWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
