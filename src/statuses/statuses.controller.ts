import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { RealtimeService } from '../realtime/realtime.service';
import { User } from '../users/user.entity';
import { CreateStatusDto } from './dto/create-status.dto';
import { SaveFilterDto } from './dto/feed-filter.dto';
import { FeedQueryDto } from './dto/feed-query.dto';
import { StatusesService } from './statuses.service';

@Controller('statuses')
@UseGuards(AuthGuard)
export class StatusesController {
  constructor(
    private readonly statuses: StatusesService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Returns immediately with state "pending"; classification happens in the background. */
  @Post()
  @HttpCode(202)
  create(@CurrentUser() user: User, @Body() dto: CreateStatusDto) {
    return this.statuses.create(user.id, dto);
  }

  @Get('feed')
  feed(@CurrentUser() user: User, @Query() query: FeedQueryDto) {
    return this.statuses.feed(user.id, query);
  }

  /** The caller's saved feed filter. */
  @Get('filter')
  getFilter(@CurrentUser() user: User) {
    return this.statuses.getFilter(user.id);
  }

  /**
   * Saves the caller's feed filter; every later GET /statuses/feed applies it.
   * A new `query` is mapped onto tags (learning new ones), so this can take a few seconds.
   */
  @Put('filter')
  saveFilter(@CurrentUser() user: User, @Body() dto: SaveFilterDto) {
    return this.statuses.saveFilter(user.id, dto);
  }

  /**
   * Server-Sent Events: status.created, status.classified, status.deleted for the
   * caller's own and their contacts' statuses, plus status.viewed for their own.
   * Browsers' EventSource can't send headers, so `?userId=` is accepted here too.
   */
  @Sse('stream')
  stream(@CurrentUser() user: User): Observable<MessageEvent> {
    return this.realtime.stream(user.id);
  }

  @Get('mine')
  mine(@CurrentUser() user: User) {
    return this.statuses.mine(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.statuses.findOwn(user.id, id);
  }

  @Post(':id/view')
  @HttpCode(204)
  view(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.statuses.markViewed(user.id, id);
  }

  @Get(':id/viewers')
  viewers(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.statuses.viewers(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.statuses.remove(user.id, id);
  }
}
