import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { UsersService } from '../users/users.service';

/**
 * Placeholder auth: the caller identifies themselves with an `x-user-id` header
 * (or `?userId=` query param).
 * Swap this for JWT / OTP auth before going to production.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    // ?userId= is for EventSource (SSE), which can't send custom headers.
    const userId = req.headers['x-user-id'] ?? req.query?.userId;
    if (typeof userId !== 'string' || !isUUID(userId)) {
      throw new UnauthorizedException('Missing or invalid x-user-id header');
    }
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Unknown user');
    req.user = user;
    return true;
  }
}
