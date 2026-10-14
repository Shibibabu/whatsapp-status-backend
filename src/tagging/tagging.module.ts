import { Module } from '@nestjs/common';
import { TagStore } from './tag-store.service';
import { TaggingService } from './tagging.service';
import { TagsController } from './tags.controller';

@Module({
  controllers: [TagsController],
  providers: [TagStore, TaggingService],
  exports: [TagStore, TaggingService],
})
export class TaggingModule {}
