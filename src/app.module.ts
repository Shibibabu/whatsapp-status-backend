import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClassificationModule } from './classification/classification.module';
import { ContactsModule } from './contacts/contacts.module';
import { RealtimeModule } from './realtime/realtime.module';
import { StatusesModule } from './statuses/statuses.module';
import { TaggingModule } from './tagging/tagging.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        // Schema lives in db/init.sql (pgvector columns aren't supported by TypeORM sync)
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(config.get('REDIS_PORT', 6379)),
        },
      }),
    }),
    RealtimeModule,
    UsersModule,
    ContactsModule,
    TaggingModule,
    ClassificationModule,
    StatusesModule,
  ],
})
export class AppModule {}
