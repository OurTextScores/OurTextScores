import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import {
  isPublicChangeReview,
  isPublicScannerJob,
  PUBLIC_EXAMPLE_VIEWER_ID
} from '../public-examples';

/**
 * Opens only the curated example resources to anonymous GET/HEAD requests.
 * Normal resources retain their authentication requirement, and examples are
 * immutable through the API even when the caller is signed in.
 */
@Injectable()
export class PublicExampleAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const isPublicExample =
      isPublicChangeReview(request.params?.reviewId) ||
      isPublicScannerJob(request.params?.jobId);
    const isRead = request.method === 'GET' || request.method === 'HEAD';

    if (isPublicExample) {
      if (isRead) {
        request.user = { userId: PUBLIC_EXAMPLE_VIEWER_ID };
        return true;
      }
      throw new ForbiddenException('Public examples are read-only');
    }
    if (request.user?.userId) return true;
    throw new UnauthorizedException('Authentication required');
  }
}
