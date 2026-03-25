import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../errorHandler';

const createMockRes = () => {
  const res: Partial<Response> & { statusCode?: number; jsonBody?: any } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (body: any) => {
    res.jsonBody = body;
    return res as Response;
  };
  return res as Response & { statusCode?: number; jsonBody?: any };
};

describe('errorHandler middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 400 with generic message for malformed JSON and no stack/internal paths', () => {
    process.env.NODE_ENV = 'production';
    const err: any = new SyntaxError('Unexpected token } in JSON at position 10');
    err.status = 400;
    err.body = '{ invalid json';

    const req = {} as Request;
    const res = createMockRes();
    const next = jest.fn() as NextFunction;

    errorHandler(err, req, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      message: 'Invalid request payload.',
    });

    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized.toLowerCase()).not.toContain('stack');
    expect(serialized).not.toContain('/orgit-api');
  });

  it('does not include stack or internal paths for generic server errors', () => {
    process.env.NODE_ENV = 'production';
    const err: any = new Error('Database connection failed');
    err.status = 500;
    err.stack = 'Error: Database connection failed\n    at /root/orgit-api/src/db.ts:10:5';

    const req = {} as Request;
    const res = createMockRes();
    const next = jest.fn() as NextFunction;

    errorHandler(err, req, res, next);

    expect(res.statusCode).toBe(500);
    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized.toLowerCase()).not.toContain('stack');
    expect(serialized).not.toContain('/root/orgit-api');
  });

  it('logs full error details including stack to server logs', () => {
    process.env.NODE_ENV = 'production';
    const err: any = new Error('Boom');
    err.status = 500;
    err.stack = 'Error: Boom\n    at /root/orgit-api/src/app.ts:1:1';

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const req = {} as Request;
    const res = createMockRes();
    const next = jest.fn() as NextFunction;

    errorHandler(err, req, res, next);

    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('Boom');
    expect(logged).toContain('/root/orgit-api/src/app.ts');

    consoleSpy.mockRestore();
  });

  it('includes more detailed message in development without stack/paths in response', () => {
    process.env.NODE_ENV = 'development';
    const err: any = new Error('DB connection failed');
    err.status = 500;
    err.stack = 'Error: DB connection failed\n    at /root/orgit-api/src/db.ts:10:5';

    const req = {} as Request;
    const res = createMockRes();
    const next = jest.fn() as NextFunction;

    errorHandler(err, req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.error).toBe('DB connection failed');

    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized.toLowerCase()).not.toContain('stack');
    expect(serialized).not.toContain('/root/orgit-api');
  });
});

