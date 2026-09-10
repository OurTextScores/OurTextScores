import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  PUBLIC_CHANGE_REVIEW_ID,
  PUBLIC_EXAMPLE_VIEWER_ID,
  PUBLIC_SCANNER_JOB_ID
} from '../public-examples';
import { PublicExampleAccessGuard } from './public-example-access.guard';

describe('PublicExampleAccessGuard', () => {
  const guard = new PublicExampleAccessGuard();

  function context(input: { method?: string; params?: Record<string, string>; userId?: string }): {
    execution: ExecutionContext;
    request: any;
  } {
    const request = {
      method: input.method || 'GET',
      params: input.params || {},
      ...(input.userId ? { user: { userId: input.userId } } : {})
    };
    return {
      request,
      execution: {
        switchToHttp: () => ({ getRequest: () => request })
      } as ExecutionContext
    };
  }

  it.each([{ reviewId: PUBLIC_CHANGE_REVIEW_ID }, { jobId: PUBLIC_SCANNER_JOB_ID }])(
    'allows anonymous reads of a curated example',
    (params) => {
      const { execution, request } = context({ params });

      expect(guard.canActivate(execution)).toBe(true);
      expect(request.user).toEqual({ userId: PUBLIC_EXAMPLE_VIEWER_ID });
    }
  );

  it('keeps non-example resources private', () => {
    const { execution } = context({ params: { jobId: 'private-job' } });

    expect(() => guard.canActivate(execution)).toThrow(UnauthorizedException);
  });

  it('rejects writes to a public example even for authenticated users', () => {
    const { execution } = context({
      method: 'DELETE',
      params: { jobId: PUBLIC_SCANNER_JOB_ID },
      userId: 'owner-1'
    });

    expect(() => guard.canActivate(execution)).toThrow(ForbiddenException);
  });

  it('allows authenticated access to normal resources', () => {
    const { execution } = context({
      method: 'PATCH',
      params: { reviewId: 'private-review' },
      userId: 'reviewer-1'
    });

    expect(guard.canActivate(execution)).toBe(true);
  });
});
