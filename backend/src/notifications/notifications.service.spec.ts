import { NotificationsService } from './notifications.service';
import { Logger } from '@nestjs/common';

describe('NotificationsService', () => {
  let svc: NotificationsService;
  const outboxModel = {
    create: jest.fn(),
    find: jest.fn(),
    updateMany: jest.fn()
  } as any;
  const inboxModel = {
    create: jest.fn(),
    find: jest.fn(),
    updateMany: jest.fn(),
    updateOne: jest.fn()
  } as any;
  const users = {
    findById: jest.fn()
  } as any;
  const config = {
    get: jest.fn().mockReturnValue(undefined)
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    inboxModel.find.mockReturnValue({
      sort: () => ({
        exec: () => Promise.resolve([]),
        limit: () => ({
          exec: () => Promise.resolve([])
        })
      })
    });
    svc = new NotificationsService(
      outboxModel as any,
      inboxModel as any,
      users as any,
      config as any
    );
    // force a mock transporter
    (svc as any).transporter = { sendMail: jest.fn().mockResolvedValue({}) };
  });

  describe('queuePushRequest', () => {
    it('creates a batchable inbox notification for the owner', async () => {
      inboxModel.create.mockResolvedValue({});
      await svc.queuePushRequest({
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        ownerUserId: 'u1'
      });
      expect(inboxModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          type: 'approval_request',
          workId: 'w',
          sourceId: 's',
          revisionId: 'r'
        })
      );
    });

    it('does nothing when there is no owner to notify', async () => {
      await svc.queuePushRequest({ workId: 'w', sourceId: 's', revisionId: 'r' });
      expect(inboxModel.create).not.toHaveBeenCalled();
    });
  });

  describe('queueNewRevision', () => {
    it('creates inbox notifications for each user', async () => {
      inboxModel.create.mockResolvedValue({});
      await svc.queueNewRevision({
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        userIds: ['u1', 'u2']
      });
      expect(inboxModel.create).toHaveBeenCalledTimes(2);
    });

    it('continues processing when a create fails', async () => {
      inboxModel.create.mockRejectedValueOnce(new Error('DB error'));
      inboxModel.create.mockResolvedValueOnce({});
      await svc.queueNewRevision({
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        userIds: ['bad', 'good']
      });
      expect(inboxModel.create).toHaveBeenCalledTimes(2);
    });

    it('handles empty userIds array', async () => {
      await svc.queueNewRevision({ workId: 'w', sourceId: 's', revisionId: 'r', userIds: [] });
      expect(inboxModel.create).not.toHaveBeenCalled();
    });
  });

  describe('queueChangeReviewActivity', () => {
    it('creates an inbox notification for review activity', async () => {
      inboxModel.create.mockResolvedValue({});
      await svc.queueChangeReviewActivity({
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        reviewId: 'cr-1',
        recipientUserId: 'u1',
        actorUserId: 'u2',
        activityType: 'thread_created',
        branchName: 'trunk'
      });
      expect(inboxModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          type: 'change_review_activity',
          workId: 'w',
          sourceId: 's',
          revisionId: 'r',
          payload: expect.objectContaining({
            reviewId: 'cr-1',
            actorUserId: 'u2',
            activityType: 'thread_created',
            branchName: 'trunk'
          })
        })
      );
    });
  });

  describe('queueScannerTerminal', () => {
    it('upserts a stable dedupe key without fake work identifiers', async () => {
      inboxModel.updateOne.mockReturnValue({ exec: () => Promise.resolve({}) });
      await svc.queueScannerTerminal({
        jobId: 'scan-1',
        generation: 1,
        recipientUserId: 'u1',
        status: 'succeeded',
        originalFilename: 'score.png',
        succeededPages: 1,
        pageCount: 1
      });
      expect(inboxModel.updateOne).toHaveBeenCalledWith(
        { dedupeKey: 'scanner:scan-1:1:terminal' },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            type: 'scanner_job_succeeded',
            resourceType: 'scanner_job',
            resourceId: 'scan-1',
            workId: undefined
          })
        }),
        { upsert: true }
      );
    });
  });

  describe('processOutbox', () => {
    it('sends approval notifications and marks sent', async () => {
      const doc = {
        type: 'push_request',
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        recipients: ['user:u1'],
        status: 'queued',
        attempts: 0,
        save: jest.fn().mockResolvedValue({})
      } as any;

      outboxModel.find.mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            exec: () => Promise.resolve([doc])
          })
        })
      });
      outboxModel.find.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => Promise.resolve([])
          })
        })
      });
      users.findById.mockResolvedValue({ email: 'user@example.com' });

      await svc.processOutbox();

      expect((svc as any).transporter.sendMail).toHaveBeenCalled();
      expect((svc as any).transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('/notifications#notification-settings')
        })
      );
      expect(doc.status).toBe('sent');
      expect(doc.attempts).toBe(1);
    });

    it('suppresses approval email when that category is disabled', async () => {
      const doc = {
        type: 'push_request',
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        recipients: ['user:u1'],
        status: 'queued',
        attempts: 0,
        save: jest.fn().mockResolvedValue({})
      } as any;
      outboxModel.find.mockReturnValueOnce({
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([doc]) }) })
      });
      users.findById.mockResolvedValue({
        email: 'user@example.com',
        notify: { emailCategories: { approvals: false } }
      });

      await svc.processOutbox();

      expect((svc as any).transporter.sendMail).not.toHaveBeenCalled();
      expect(doc.status).toBe('sent');
    });

    it('handles email recipients directly', async () => {
      const doc = {
        type: 'push_request',
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        recipients: ['test@example.com'],
        status: 'queued',
        attempts: 0,
        save: jest.fn().mockResolvedValue({})
      } as any;

      outboxModel.find.mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            exec: () => Promise.resolve([doc])
          })
        })
      });
      outboxModel.find.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => Promise.resolve([])
          })
        })
      });

      await svc.processOutbox();

      expect((svc as any).transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com'
        })
      );
    });

    it('logs when no transporter available', async () => {
      (svc as any).transporter = null;
      const logSpy = jest.spyOn((svc as any).logger, 'log');
      const doc = {
        type: 'push_request',
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        recipients: ['user:u1'],
        status: 'queued',
        attempts: 0,
        save: jest.fn().mockResolvedValue({})
      } as any;

      outboxModel.find.mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            exec: () => Promise.resolve([doc])
          })
        })
      });
      outboxModel.find.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => Promise.resolve([])
          })
        })
      });
      users.findById.mockResolvedValue({ email: 'user@example.com' });

      await svc.processOutbox();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('(no transporter)'));
      expect(doc.status).toBe('sent');
    });

    it('marks as error when sendMail fails', async () => {
      (svc as any).transporter = { sendMail: jest.fn().mockRejectedValue(new Error('SMTP error')) };
      const doc = {
        type: 'push_request',
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        recipients: ['user:u1'],
        status: 'queued',
        attempts: 0,
        save: jest.fn().mockResolvedValue({})
      } as any;

      outboxModel.find.mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            exec: () => Promise.resolve([doc])
          })
        })
      });
      outboxModel.find.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => Promise.resolve([])
          })
        })
      });
      users.findById.mockResolvedValue({ email: 'user@example.com' });

      await svc.processOutbox();

      expect(doc.status).toBe('error');
      expect(doc.lastError).toContain('SMTP error');
      expect(doc.attempts).toBe(1);
    });

    it('skips when no emails resolved', async () => {
      (svc as any).transporter = null;
      const logSpy = jest.spyOn((svc as any).logger, 'log');
      const doc = {
        type: 'push_request',
        workId: 'w',
        sourceId: 's',
        revisionId: 'r',
        recipients: ['user:u1'],
        status: 'queued',
        attempts: 0,
        save: jest.fn().mockResolvedValue({})
      } as any;

      outboxModel.find.mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            exec: () => Promise.resolve([doc])
          })
        })
      });
      outboxModel.find.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => Promise.resolve([])
          })
        })
      });
      users.findById.mockResolvedValue(null); // User not found

      await svc.processOutbox();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('(no recipients)'));
      expect(doc.status).toBe('sent');
    });

    it('processes inbox digests for daily period', async () => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const digestDoc = {
        notificationId: 'n1',
        userId: 'u1',
        type: 'new_revision',
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r1',
        createdAt: dayAgo,
        emailSent: false,
        save: jest.fn().mockResolvedValue({})
      };

      // Outbox (approvals) empty
      outboxModel.find.mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            exec: () => Promise.resolve([])
          })
        })
      });
      inboxModel.find.mockReturnValue({
        sort: () => ({
          exec: () => Promise.resolve([digestDoc])
        })
      });
      users.findById.mockResolvedValue({
        email: 'user@example.com',
        notify: { watchPreference: 'daily' }
      });

      await svc.processOutbox();

      expect((svc as any).transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('[daily digest]')
        })
      );
      expect(digestDoc.emailSent).toBe(true);
    });

    it('keeps in-app notifications but suppresses disabled email categories', async () => {
      const comment = {
        notificationId: 'comment',
        userId: 'u1',
        type: 'source_comment',
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r1',
        createdAt: new Date(),
        emailSent: false,
        save: jest.fn().mockResolvedValue({})
      } as any;
      const revision = {
        notificationId: 'revision',
        userId: 'u1',
        type: 'new_revision',
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r2',
        createdAt: new Date(),
        emailSent: false,
        save: jest.fn().mockResolvedValue({})
      } as any;
      outboxModel.find.mockReturnValueOnce({
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) })
      });
      inboxModel.find.mockReturnValue({
        sort: () => ({ exec: () => Promise.resolve([comment, revision]) })
      });
      users.findById.mockResolvedValue({
        email: 'user@example.com',
        notify: {
          watchPreference: 'immediate',
          emailCategories: { comments: false, revisions: true }
        }
      });

      await svc.processOutbox();

      expect((svc as any).transporter.sendMail).toHaveBeenCalledTimes(1);
      expect((svc as any).transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('New revision'),
          html: expect.stringContaining('/notifications#notification-settings')
        })
      );
      expect(comment.emailSent).toBe(true);
      expect(comment.emailSuppressedAt).toBeInstanceOf(Date);
      expect(comment.read).toBeUndefined();
      expect(revision.emailSent).toBe(true);
    });

    it('suppresses every email when the catch-all is disabled', async () => {
      const notification = {
        notificationId: 'scan',
        userId: 'u1',
        type: 'scanner_job_succeeded',
        resourceType: 'scanner_job',
        resourceId: 'scan-1',
        payload: { originalFilename: 'score.png' },
        createdAt: new Date(),
        emailSent: false,
        save: jest.fn().mockResolvedValue({})
      } as any;
      outboxModel.find.mockReturnValueOnce({
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) })
      });
      inboxModel.find.mockReturnValue({
        sort: () => ({ exec: () => Promise.resolve([notification]) })
      });
      users.findById.mockResolvedValue({
        email: 'user@example.com',
        notify: { emailEnabled: false }
      });

      await svc.processOutbox();

      expect((svc as any).transporter.sendMail).not.toHaveBeenCalled();
      expect(notification.emailSent).toBe(true);
      expect(notification.emailSuppressedAt).toBeInstanceOf(Date);
    });
  });

  describe('onModuleInit', () => {
    it('sets up timer and transporter from config', () => {
      jest.useFakeTimers();
      config.get.mockImplementation((key: string) => {
        if (key === 'EMAIL_SERVER') return 'smtp://test';
        if (key === 'EMAIL_FROM') return 'test@example.com';
        if (key === 'PUBLIC_WEB_BASE_URL') return 'https://example.com/';
        return undefined;
      });

      const newSvc = new NotificationsService(outboxModel, inboxModel, users, config);
      newSvc.onModuleInit();

      expect((newSvc as any).timer).toBeDefined();
      expect((newSvc as any).emailFrom).toBe('test@example.com');
      expect((newSvc as any).publicWebBaseUrl).toBe('https://example.com');

      newSvc.onModuleDestroy();
      jest.useRealTimers();
    });

    it('handles missing email server config', () => {
      config.get.mockReturnValue(undefined);

      const newSvc = new NotificationsService(outboxModel, inboxModel, users, config);
      newSvc.onModuleInit();

      expect((newSvc as any).transporter).toBeNull();

      newSvc.onModuleDestroy();
    });

    it('handles invalid email server config', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      config.get.mockImplementation((key: string) => {
        if (key === 'EMAIL_SERVER') return 'invalid://bad-config';
        return undefined;
      });

      const newSvc = new NotificationsService(outboxModel, inboxModel, users, config);
      newSvc.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to configure email transporter')
      );

      newSvc.onModuleDestroy();
      warnSpy.mockRestore();
    });
  });

  describe('onModuleDestroy', () => {
    it('clears timer', () => {
      jest.useFakeTimers();
      const newSvc = new NotificationsService(outboxModel, inboxModel, users, config);
      newSvc.onModuleInit();

      const timer = (newSvc as any).timer;
      expect(timer).toBeDefined();

      newSvc.onModuleDestroy();

      jest.useRealTimers();
    });

    it('handles null timer', () => {
      const newSvc = new NotificationsService(outboxModel, inboxModel, users, config);
      (newSvc as any).timer = null;

      // Should not throw
      expect(() => newSvc.onModuleDestroy()).not.toThrow();
    });
  });

  describe('renderSubject', () => {
    it('renders push_request subject', () => {
      const subject = (svc as any).renderSubject('push_request', 'work1', 'source1', 'rev1');
      expect(subject).toContain('Approval requested');
      expect(subject).toContain('work1/source1');
      expect(subject).toContain('rev1');
    });

    it('renders new_revision subject', () => {
      const subject = (svc as any).renderSubject('new_revision', 'work1', 'source1', 'rev1');
      expect(subject).toContain('New revision');
      expect(subject).toContain('work1/source1');
      expect(subject).toContain('rev1');
    });

    it('defaults to new_revision for unknown type', () => {
      const subject = (svc as any).renderSubject('unknown_type', 'work1', 'source1', 'rev1');
      expect(subject).toContain('New revision');
    });
  });

  describe('renderHtml', () => {
    beforeEach(() => {
      (svc as any).publicWebBaseUrl = 'https://example.com';
    });

    it('renders push_request HTML with approval link', () => {
      const html = (svc as any).renderHtml('push_request', 'work1', 'source1', 'rev1');
      expect(html).toContain('requires your approval');
      expect(html).toContain('rev1');
      expect(html).toContain('work1/source1');
      expect(html).toContain('https://example.com/approvals');
      expect(html).toContain('https://example.com/works/work1');
    });

    it('renders new_revision HTML', () => {
      const html = (svc as any).renderHtml('new_revision', 'work1', 'source1', 'rev1');
      expect(html).toContain('was approved');
      expect(html).toContain('rev1');
      expect(html).toContain('work1/source1');
      expect(html).toContain('https://example.com/works/work1');
    });

    it('URL encodes workId', () => {
      const html = (svc as any).renderHtml('new_revision', 'work with spaces', 'source1', 'rev1');
      expect(html).toContain('work%20with%20spaces');
    });
  });
});
