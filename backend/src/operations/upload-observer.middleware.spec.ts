import { EventEmitter } from 'node:events';
import { observeUploads } from './upload-observer.middleware';

describe('upload observation', () => {
  it('records a middleware rejection once, without recording body or credential values', () => {
    const record = jest.fn();
    const req: any = {
      method: 'POST',
      path: '/api/projects/1/sources',
      header: (name: string) =>
        name === 'x-upload-attempt-id' ? '12345678-1234-1234-1234-123456789012' : undefined,
      user: { userId: 'admin', roles: ['admin'] },
      body: { secret: 'do not store' }
    };
    const res: any = Object.assign(new EventEmitter(), {
      statusCode: 429,
      setHeader: jest.fn(),
      getHeader: () => '2000000000',
      writableFinished: true
    });
    observeUploads({ record } as any)(req, res, jest.fn());
    res.emit('finish');
    res.emit('close');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        role: 'admin',
        category: 'rate_limited',
        userId: 'admin'
      })
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('do not store');
  });
  it('records interrupted connections as unknown instead of success', () => {
    const record = jest.fn();
    const req: any = { method: 'POST', path: '/api/scanner/jobs', header: () => undefined };
    const res: any = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      getHeader: () => undefined,
      writableFinished: false
    });
    observeUploads({ record } as any)(req, res, jest.fn());
    res.emit('close');
    expect(record.mock.calls[0][0].status).toBe(0);
  });
});
