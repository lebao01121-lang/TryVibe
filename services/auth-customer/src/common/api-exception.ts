import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import {
  createApiErrorResponse,
  ErrorCode,
  type ErrorCode as ErrorCodeType,
} from '@atelier/contracts';
import {
  createLogger,
  getOrCreateCorrelationId,
  type HeaderBag,
} from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';

export class ApiDomainException extends HttpException {
  readonly code: ErrorCodeType;
  readonly details?: Record<string, unknown>;

  constructor(
    status: HttpStatus,
    code: ErrorCodeType,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }
}

export function parseWithZod<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw new ApiDomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      issues[0]?.message || 'Dữ liệu đầu vào không hợp lệ.',
      { issues },
    );
  }
  return result.data as z.output<S>;
}

export function getCorrelationIdFromRequest(req: Request): string {
  const existing = (req as Request & { correlationId?: string }).correlationId;
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }
  return getOrCreateCorrelationId(req.headers as HeaderBag);
}

export function extractBearerToken(req: Request): string | null {
  const raw = req.headers.authorization;
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function extractClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    return xff.split(',')[0].trim().slice(0, 64);
  }
  if (Array.isArray(xff) && xff.length > 0 && xff[0]) {
    return xff[0].split(',')[0].trim().slice(0, 64);
  }
  return (req.ip || req.socket?.remoteAddress || '127.0.0.1').slice(0, 64);
}

export function isHttpsRequest(req: Request): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return Boolean(req.secure);
}

@Catch()
export class AtelierExceptionFilter implements ExceptionFilter {
  private readonly logger = createLogger('@atelier/auth-customer:http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = getCorrelationIdFromRequest(req);

    if (exception instanceof ApiDomainException) {
      const status = exception.getStatus();
      res
        .status(status)
        .json(
          createApiErrorResponse(exception.code, exception.message, exception.details, {
            correlationId,
            service: SERVICE_NAME,
          }),
        );
      return;
    }

    if (exception instanceof ZodError) {
      const issues = exception.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      res
        .status(HttpStatus.BAD_REQUEST)
        .json(
          createApiErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            issues[0]?.message || 'Dữ liệu không hợp lệ.',
            { issues },
            { correlationId, service: SERVICE_NAME },
          ),
        );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawResponse = exception.getResponse();
      const message =
        typeof rawResponse === 'string'
          ? rawResponse
          : typeof rawResponse === 'object' &&
              rawResponse !== null &&
              'message' in rawResponse &&
              typeof (rawResponse as { message: unknown }).message === 'string'
            ? (rawResponse as { message: string }).message
            : exception.message;

      const mappedCode: ErrorCodeType =
        status === HttpStatus.UNAUTHORIZED
          ? ErrorCode.UNAUTHORIZED
          : status === HttpStatus.FORBIDDEN
            ? ErrorCode.FORBIDDEN
            : status === HttpStatus.NOT_FOUND
              ? ErrorCode.NOT_FOUND
              : status === HttpStatus.CONFLICT
                ? ErrorCode.CONFLICT
                : status === HttpStatus.BAD_REQUEST
                  ? ErrorCode.VALIDATION_ERROR
                  : ErrorCode.INTERNAL_ERROR;

      res
        .status(status)
        .json(
          createApiErrorResponse(mappedCode, message, undefined, {
            correlationId,
            service: SERVICE_NAME,
          }),
        );
      return;
    }

    this.logger.error({ err: exception, correlationId, path: req.url }, 'Unhandled exception');
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(
        createApiErrorResponse(
          ErrorCode.INTERNAL_ERROR,
          'Đã xảy ra lỗi hệ thống trong quá trình xử lý yêu cầu.',
          undefined,
          { correlationId, service: SERVICE_NAME },
        ),
      );
  }
}
