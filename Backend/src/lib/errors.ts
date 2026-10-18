export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (code: string, msg: string) => new AppError(400, code, msg),
  unauthorized: (code: string, msg = 'Unauthorized') => new AppError(401, code, msg),
  forbidden: (code: string, msg = 'Forbidden') => new AppError(403, code, msg),
  notFound: (code: string, msg = 'Not found') => new AppError(404, code, msg),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
  tooMany: (code: string, msg: string) => new AppError(429, code, msg),
  unavailable: (code: string, msg: string) => new AppError(503, code, msg),
};
