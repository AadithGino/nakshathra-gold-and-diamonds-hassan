import { afterAll } from '@jest/globals';
import { stopJestHttp } from './helpers/http.js';

afterAll(async () => {
  await stopJestHttp();
});
