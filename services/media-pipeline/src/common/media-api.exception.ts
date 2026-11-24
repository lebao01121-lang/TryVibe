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

export class MediaApiException extends HttpException {
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
    case HttpStatus.PAYLOAD_TOO_LARGE:
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

    if (exception instanceof MediaApiException) {
      const status = exception.getStatus();
      const body = createApiErrorResponse(
        exception.errorCode,
        exception.message,
        exception.details,
        { correlationId, service: SERVICE_NAME },
      );
      response.status(status).json(body);
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

      const code = mapHttpStatusToErrorCode(status);
      const body = createApiErrorResponse(code, message, details, {
        correlationId,
        service: SERVICE_NAME,
      });
      response.status(status).json(body);
      return;
    }

    // Handle Multer errors or Express body-parser size errors gracefully
    if (exception && typeof exception === 'object') {
      const errObj = exception as { code?: string; status?: number; message?: string };
      if (errObj.code === 'LIMIT_FILE_SIZE' || errObj.status === 413) {
        const body = createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Kích thước tệp vượt quá giới hạn tối đa 10MB. / File size exceeds maximum allowed limit (10MB).',
          { maxSizeBytes: 10 * 1024 * 1024 },
          { correlationId, service: SERVICE_NAME },
        );
        response.status(HttpStatus.BAD_REQUEST).json(body);
        return;
      }
    }

    this.logger.error(
      { err: exception, correlationId, path: request.url, method: request.method },
      'Unhandled exception in media-pipeline',
    );

    const body = createApiErrorResponse(
      ErrorCode.INTERNAL_ERROR,
      'Đã xảy ra lỗi hệ thống nội bộ khi xử lý media. / Internal media pipeline error.',
      undefined,
      { correlationId, service: SERVICE_NAME },
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
