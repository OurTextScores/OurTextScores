import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser } from './types/auth-user';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestUser | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return (req as any).user as RequestUser | undefined;
  }
);

