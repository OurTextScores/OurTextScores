import {
  notificationEmailEnabled,
  notificationPreferencesWithDefaults
} from './notification-preferences';

describe('notification email preferences', () => {
  it('keeps legacy users subscribed by default', () => {
    expect(notificationEmailEnabled(undefined, 'comments')).toBe(true);
    expect(notificationPreferencesWithDefaults({ watchPreference: 'daily' })).toEqual({
      watchPreference: 'daily',
      emailEnabled: true,
      emailCategories: {
        comments: true,
        revisions: true,
        reviews: true,
        scanner: true,
        approvals: true
      }
    });
  });

  it('honors both the catch-all and individual category switches', () => {
    expect(
      notificationEmailEnabled(
        { emailEnabled: false, emailCategories: { scanner: true } },
        'scanner'
      )
    ).toBe(false);
    expect(notificationEmailEnabled({ emailCategories: { comments: false } }, 'comments')).toBe(
      false
    );
    expect(notificationEmailEnabled({ emailCategories: { comments: false } }, 'revisions')).toBe(
      true
    );
  });
});
