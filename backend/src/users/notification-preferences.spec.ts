import { model } from 'mongoose';
import {
  notificationEmailEnabled,
  notificationPreferencesWithDefaults
} from './notification-preferences';
import { UserSchema } from './schemas/user.schema';

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

  it('returns plain values for a stored user, not the database subdocument', () => {
    // What the controller passes in: `notify` of a document, whose `emailCategories` is a
    // subdocument. No connection is needed to build one.
    const User = model('NotificationPreferencesSpecUser', UserSchema);
    const user = new User({
      email: 'reader@example.org',
      notify: { watchPreference: 'weekly', emailCategories: { comments: false } }
    });

    const preferences = notificationPreferencesWithDefaults(user.notify);

    expect(Object.keys(preferences.emailCategories).sort()).toEqual([
      'approvals',
      'comments',
      'reviews',
      'revisions',
      'scanner'
    ]);
    // As the API sends it.
    expect(JSON.parse(JSON.stringify(preferences))).toEqual({
      watchPreference: 'weekly',
      emailEnabled: true,
      emailCategories: {
        comments: false,
        revisions: true,
        reviews: true,
        scanner: true,
        approvals: true
      }
    });
  });

  it('ignores a stored value that is not a switch', () => {
    expect(
      notificationPreferencesWithDefaults({
        emailCategories: { comments: 'no' as unknown as boolean, scanner: false }
      }).emailCategories
    ).toEqual({ comments: true, revisions: true, reviews: true, scanner: false, approvals: true });
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
