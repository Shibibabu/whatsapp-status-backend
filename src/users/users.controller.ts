import { Body, Controller, Get, HttpCode, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { User } from './user.entity';
import { UsersService } from './users.service';

class RegisterDto {
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be 7-15 digits, optional leading +' })
  phone: string;

  @IsString()
  @Length(1, 80)
  name: string;
}

class LoginDto {
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be 7-15 digits, optional leading +' })
  phone: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  register(@Body() dto: RegisterDto) {
    return this.users.create(dto.phone, dto.name);
  }

  /** Placeholder login: returns the user for a phone number (no OTP/password yet). */
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const user = await this.users.findByPhone(dto.phone);
    if (!user) throw new NotFoundException('No user with that phone. Register first.');
    return user;
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: User) {
    return user;
  }
}
