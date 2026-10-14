import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClassificationModule } from '../classification/classification.module';
import { TaggingModule } from '../tagging/tagging.module';
import { Status } from './status.entity';
import { StatusesController } from './statuses.controller';
import { StatusesService } from './statuses.service';

@Module({
  imports: [TypeOrmModule.forFeature([Status]), ClassificationModule, TaggingModule],
  controllers: [StatusesController],
  providers: [StatusesService],
})
export class StatusesModule {}
