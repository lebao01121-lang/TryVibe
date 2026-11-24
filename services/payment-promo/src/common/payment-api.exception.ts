import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createApiErrorResponse, ErrorCode } from '@atelier/contracts';
import {
  createLogger,
  getOrCreateCorrelationId,
  type HeaderBag,
} from '@atelier/observability';
import type { Request, Response } from 'express';
import { SERVICE_NAME } from '../config/env';

export class PaymentApiException extends HttpException {
  public readonly errorCode: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    status: HttpStatus,
    errorCode: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super({ code: errorCode, message, details }, status);
    this.errorCode = errorCode;
    this.details = details;
  }
}

function mapHttpStatusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ErrorCode.VALIDATION_ERROR;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    case HttpStatus.SERVICE_UNAVAILABLE:
    case HttpStatus.BAD_GATEWAY:
      return ErrorCode.DEPENDENCY_UNAVAILABLE;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = createLogger(SERVICE_NAME);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const correlationId = getOrCreateCorrelationId(request.headers as HeaderBag);

    if (exception instanceof PaymentApiException) {
      const body = createApiErrorResponse(
        exception.errorCode,
        exception.message,
        exception.details,
        { correlationId, service: SERVICE_NAME },
      );
      response.status(exception.getStatus()).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      let message = exception.message;
      let details: Record<string, unknown> | undefined;

      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (typeof record.message === 'string') {
          message = record.message;
        } else if (Array.isArray(record.message)) {
          message = record.message.join('; ');
        }
        if (record.details && typeof record.details === 'object') {
          details = record.details as Record<string, unknown>;
        }
      }

      const body = createApiErrorResponse(
        mapHttpStatusToErrorCode(status),
        message,
        details,
        { correlationId, service: SERVICE_NAME },
      );
      response.status(status).json(body);
      return;
    }

    this.logger.error(
      { err: exception, correlationId, path: request.url, method: request.method },
      'Unhandled exception in payment-promo microservice',
    );

    const body = createApiErrorResponse(
      ErrorCode.INTERNAL_ERROR,
      'Đã xảy ra lỗi hệ thống nội bộ khi xử lý thanh toán / khuyến mãi. / Internal payment-promo error.',
      undefined,
      { correlationId, service: SERVICE_NAME },
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
