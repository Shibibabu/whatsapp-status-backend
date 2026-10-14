import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  findById(id: string) {
    return this.repo.findOneBy({ id });
  }

  findByPhone(phone: string) {
    return this.repo.findOneBy({ phone });
  }

  async create(phone: string, name: string) {
    if (await this.findByPhone(phone)) {
      throw new ConflictException('Phone already registered');
    }
    return this.repo.save(this.repo.create({ phone, name }));
  }
}
