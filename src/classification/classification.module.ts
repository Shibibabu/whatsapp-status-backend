import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TaggingModule } from '../tagging/tagging.module';
import { CLASSIFY_QUEUE } from './classification.constants';
import { ClassificationProcessor } from './classification.processor';

@Module({
  imports: [
    TaggingModule,
    BullModule.registerQueue({
      name: CLASSIFY_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
  ],
  providers: [ClassificationProcessor],
  exports: [BullModule],
})
export class ClassificationModule {}
