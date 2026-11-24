import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createApiErrorResponse, ErrorCode } from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import { SERVICE_NAME } from '../config/env';

function mapStatusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.VALIDATION_ERROR;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

@Catch()
export class NotifyHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
    let message = 'Internal notify-review service error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = mapStatusToErrorCode(status);
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const rec = body as Record<string, unknown>;
        if (
          typeof rec.code === 'string' &&
          (Object.values(ErrorCode) as string[]).includes(rec.code)
        ) {
          code = rec.code as ErrorCode;
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
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    res.status(status).json(
      createApiErrorResponse(code, message, details, {
        correlationId,
        service: SERVICE_NAME,
      }),
    );
  }
}
