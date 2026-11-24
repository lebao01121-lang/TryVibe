import * as crypto from 'node:crypto';
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

export function extractHeader(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    const first = raw[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function timingSafeSecretEqual(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function assertInternalSecret(headers: HeaderBag, expectedSecret: string): void {
  const provided = extractHeader(headers, 'x-internal-secret');
  if (!provided || !timingSafeSecretEqual(provided, expectedSecret)) {
    throw new ApiDomainException(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      'Header x-internal-secret không hợp lệ hoặc bị thiếu.',
    );
  }
}

export function getCorrelationIdFromRequest(req: Request): string {
  const existing = (req as Request & { correlationId?: string }).correlationId;
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }
  return getOrCreateCorrelationId(req.headers as HeaderBag);
}

const VALID_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = createLogger('@atelier/order-rma:http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = getCorrelationIdFromRequest(req);

    if (exception instanceof ApiDomainException) {
      res
        .status(exception.getStatus())
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
            issues[0]?.message || 'Dữ liệu đầu vào không hợp lệ.',
            { issues },
            { correlationId, service: SERVICE_NAME },
          ),
        );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawResponse = exception.getResponse();
      let message = exception.message;
      let code: ErrorCodeType =
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
      let details: Record<string, unknown> | undefined;

      if (typeof rawResponse === 'string') {
        message = rawResponse;
      } else if (rawResponse && typeof rawResponse === 'object') {
        const rec = rawResponse as Record<string, unknown>;
        if (typeof rec.code === 'string' && VALID_ERROR_CODES.has(rec.code)) {
          code = rec.code as ErrorCodeType;
        }
        if (typeof rec.message === 'string') {
          message = rec.message;
        } else if (Array.isArray(rec.message)) {
          message = rec.message.join('; ');
        }
        if (rec.details && typeof rec.details === 'object') {
          details = rec.details as Record<string, unknown>;
        }
      }

      res
        .status(status)
        .json(
          createApiErrorResponse(code, message, details, {
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
          'Đã xảy ra lỗi hệ thống tại dịch vụ đơn hàng và đổi trả.',
          undefined,
          { correlationId, service: SERVICE_NAME },
        ),
      );
  }
}
