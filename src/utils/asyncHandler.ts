import type { NextFunction, RequestHandler, Response } from 'express';

type AsyncRouteHandler = (
  request: any,
  response: Response,
  next: NextFunction,
) => unknown | Promise<unknown>;

export const asyncHandler =
  (handler: AsyncRouteHandler): RequestHandler =>
  (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
