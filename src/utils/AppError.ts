export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly retryable = false,
    public readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details: unknown[] = []) =>
    new AppError('VALIDATION_ERROR', 'The request is invalid', 422, false, details),
  auth: () => new AppError('AUTHENTICATION_REQUIRED', 'Authentication required', 401),
  permission: () =>
    new AppError('PERMISSION_DENIED', 'You do not have permission for this action', 403),
  notFound: (entity: string) =>
    new AppError(`${entity.toUpperCase()}_NOT_FOUND`, `${entity} not found`, 404),
};
