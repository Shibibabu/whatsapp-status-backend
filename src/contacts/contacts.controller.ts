import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Matches } from 'class-validator';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { User } from '../users/user.entity';
import { ContactsService } from './contacts.service';

class AddContactDto {
  @Matches(/^\+?[0-9]{7,15}$/)
  phone: string;
}

@Controller('contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Post()
  add(@CurrentUser() user: User, @Body() dto: AddContactDto) {
    return this.contacts.add(user.id, dto.phone);
  }

  @Get()
  list(@CurrentUser() user: User) {
    return this.contacts.list(user.id);
  }

  @Delete(':contactId')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('contactId', ParseUUIDPipe) contactId: string) {
    return this.contacts.remove(user.id, contactId);
  }
}
