import type { Role } from './models/index.js';
declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: { userId: string; role: Role; permissions: string[]; sessionVersion: number };
      rawBody?: Buffer;
    }
  }
}
export {};
