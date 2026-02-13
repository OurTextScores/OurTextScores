import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { UsersService } from '../../users/users.service';

@Injectable()
export class AuthOptionalGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers?.authorization as string | undefined;
    const principal = this.auth.optionalUser(header);
    if (principal) {
      // Best-effort user upsert by email if available to populate roles
      if (principal.email) {
        const userDoc = await this.users.getOrCreateByEmail(principal.email, principal.name);
        (req as any).user = {
          userId: String(userDoc._id),
          email: userDoc.email,
          name: userDoc.displayName ?? principal.name,
          roles: Array.isArray(userDoc.roles) ? userDoc.roles : [],
          ...(userDoc.status ? { status: userDoc.status } : {})
        };
      } else {
        (req as any).user = principal;
      }
    }
    return true; // allow through regardless
  }
}
