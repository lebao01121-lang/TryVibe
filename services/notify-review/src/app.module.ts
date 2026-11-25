import { Module } from '@nestjs/common';
import { loadNotifyReviewConfig, NOTIFY_CONFIG_TOKEN } from './config/env';
import { NotifyDbService } from './db/notify-db.service';
import { ReviewEventPublisherService } from './messaging/review-event-publisher.service';
import { InternalNotifyController } from './notifications/internal-notify.controller';
import { NotificationService } from './notifications/notification.service';
import { NotifyDlqService } from './notifications/notify-dlq.service';
import { ZaloZnsClient } from './notifications/zalo-zns.client';
import { ReviewsController } from './reviews/reviews.controller';
import { ReviewsService } from './reviews/reviews.service';
import { SentimentService } from './reviews/sentiment.service';
import { NotifyReviewController } from './service.controller';

@Module({
  controllers: [NotifyReviewController, ReviewsController, InternalNotifyController],
  providers: [
    {
      provide: NOTIFY_CONFIG_TOKEN,
      useFactory: () => loadNotifyReviewConfig(),
    },
    NotifyDbService,
    ZaloZnsClient,
    NotifyDlqService,
    NotificationService,
    ReviewEventPublisherService,
    SentimentService,
    ReviewsService,
  ],
})
export class AppModule {}
