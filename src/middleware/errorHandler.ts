import { Request, Response, NextFunction } from 'express';

/**
 * Global error handler.
 *
 * Goals:
 * - Do NOT leak stack traces, internal paths, or framework details in responses.
 * - Special-case malformed JSON (from express.json) with a fixed 400 response.
 * - Log full error (including stack) server-side.
 * - Show more detailed messages only in non-production, but still without stack/paths.
 */
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isProduction = process.env.NODE_ENV === 'production';

  // Log full details (including stack) to server logs only
  const errorToLog = err && err.stack ? err.stack : err;
  // eslint-disable-next-line no-console
  console.error('Error:', errorToLog);

  // Handle malformed JSON from express.json() / body-parser
  if (
    err instanceof SyntaxError &&
    (err as any).status === 400 &&
    'body' in (err as any)
  ) {
    res.status(400).json({
      success: false,
      message: 'Invalid request payload.',
    });
    return;
  }

  const status: number =
    typeof err?.status === 'number' && err.status >= 400 && err.status <= 599
      ? err.status
      : 500;

  let message: string;

  if (status >= 500) {
    // Server-side errors: generic message in production, detailed in non-production
    message = isProduction
      ? 'Internal server error'
      : err?.message || 'Internal server error';
  } else if (status === 400) {
    message = isProduction
      ? 'Invalid request.'
      : err?.message || 'Invalid request.';
  } else if (status === 401) {
    message = 'Unauthorized';
  } else if (status === 403) {
    message = 'Forbidden';
  } else if (status === 404) {
    message = 'Not found';
  } else {
    message = isProduction
      ? 'Request failed.'
      : err?.message || 'Request failed.';
  }

  // Important: never include stack traces or internal paths in the response body.
  res.status(status).json({
    success: false,
    error: message,
  });
}

