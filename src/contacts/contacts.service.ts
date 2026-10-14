import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { Contact } from './contact.entity';

@Injectable()
export class ContactsService {
  constructor(
    @InjectRepository(Contact) private readonly repo: Repository<Contact>,
    private readonly users: UsersService,
  ) {}

  async add(userId: string, phone: string) {
    const contact = await this.users.findByPhone(phone);
    if (!contact) throw new NotFoundException('No user with that phone');
    if (contact.id === userId) throw new BadRequestException('Cannot add yourself');
    await this.repo.upsert({ userId, contactId: contact.id }, ['userId', 'contactId']);
    return contact;
  }

  async remove(userId: string, contactId: string) {
    await this.repo.delete({ userId, contactId });
  }

  list(userId: string) {
    return this.repo.query(
      `SELECT u.id, u.phone, u.name FROM contacts c
       JOIN users u ON u.id = c.contact_id
       WHERE c.user_id = $1 ORDER BY u.name`,
      [userId],
    );
  }
}
