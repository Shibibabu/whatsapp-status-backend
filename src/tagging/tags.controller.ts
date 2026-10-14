import { Controller, Get } from '@nestjs/common';
import { TagStore } from './tag-store.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly store: TagStore) {}

  /** Every known tag, for the filter UI. Grows as new tags are created. */
  @Get()
  list() {
    return this.store.all();
  }
}
