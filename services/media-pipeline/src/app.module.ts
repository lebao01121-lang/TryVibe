import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './common/media-api.exception';
import { loadMediaPipelineConfig, MEDIA_CONFIG_TOKEN } from './config/env';
import { MediaDbService } from './db/media-db.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { MediaEventPublisherService } from './messaging/media-event-publisher.service';
import { MediaPipelineController } from './service.controller';
import { MinioStorageService } from './storage/minio-storage.service';

@Module({
  controllers: [MediaPipelineController, MediaController],
  providers: [
    {
      provide: MEDIA_CONFIG_TOKEN,
      useFactory: () => loadMediaPipelineConfig(),
    },
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    MediaDbService,
    MinioStorageService,
    MediaEventPublisherService,
    MediaService,
  ],
})
export class AppModule {}
