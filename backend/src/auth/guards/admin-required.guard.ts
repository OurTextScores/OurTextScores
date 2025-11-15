import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestUser } from '../types/auth-user';

@Injectable()
export class AdminRequiredGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = (req as any).user as RequestUser | undefined;
    const roles = user?.roles ?? [];

    if (!roles.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }

    return true;
  }
}

