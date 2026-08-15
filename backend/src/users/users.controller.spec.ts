import { UsersController } from './users.controller';

describe('UsersController', () => {
  const users = {
    findById: jest.fn()
  } as any;
  const controller = new UsersController(users as any);

  it('me returns user payload', async () => {
    users.findById.mockResolvedValue({ _id: 'id1', email: 'u@example.com', displayName: 'U', roles: ['user'], notify: { watchPreference: 'daily' } });
    const out = await controller.me({ userId: 'id1' } as any);
    expect(out.user.email).toBe('u@example.com');
  });

  it('updatePreferences updates notify field', async () => {
    const doc: any = { _id: 'id1', email: 'u@example.com', notify: { watchPreference: 'immediate' }, save: jest.fn().mockResolvedValue({}) };
    users.findById.mockResolvedValue(doc);
    const out = await controller.updatePreferences(
      { userId: 'id1' } as any,
      {
        watchPreference: 'weekly',
        emailEnabled: false,
        emailCategories: { comments: false, scanner: true }
      }
    );
    expect(out.ok).toBe(true);
    expect(doc.notify.watchPreference).toBe('weekly');
    expect(doc.notify.emailEnabled).toBe(false);
    expect(doc.notify.emailCategories.comments).toBe(false);
    expect(doc.notify.emailCategories.scanner).toBe(true);
    expect(doc.notify.emailCategories.revisions).toBe(true);
  });
});
