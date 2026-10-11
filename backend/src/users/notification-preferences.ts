export const NOTIFICATION_EMAIL_CATEGORIES = [
  'comments',
  'revisions',
  'reviews',
  'scanner',
  'approvals'
] as const;

export type NotificationEmailCategory = (typeof NOTIFICATION_EMAIL_CATEGORIES)[number];

export function isNotificationEmailCategory(value: string): value is NotificationEmailCategory {
  return NOTIFICATION_EMAIL_CATEGORIES.includes(value as NotificationEmailCategory);
}

export type NotificationEmailCategories = Partial<Record<NotificationEmailCategory, boolean>>;

export interface UserNotificationPreferences {
  watchPreference?: 'immediate' | 'daily' | 'weekly';
  /** Master switch. In-app notifications are deliberately unaffected. */
  emailEnabled?: boolean;
  emailCategories?: NotificationEmailCategories;
}

export const DEFAULT_NOTIFICATION_EMAIL_CATEGORIES: Record<NotificationEmailCategory, boolean> = {
  comments: true,
  revisions: true,
  reviews: true,
  scanner: true,
  approvals: true
};

/** Missing fields belong to users created before email opt-outs and default on. */
export function notificationEmailEnabled(
  preferences: UserNotificationPreferences | null | undefined,
  category: NotificationEmailCategory
): boolean {
  return preferences?.emailEnabled !== false && preferences?.emailCategories?.[category] !== false;
}

/**
 * The preferences as plain values, with defaults for what was never set.
 *
 * `preferences` is usually a stored document's `notify`, and its `emailCategories` a database
 * subdocument. Each switch is therefore read by name: spreading a subdocument copies its
 * internals (`$__`, `$__parent`, `_doc`) along with the five fields, and they went out in the
 * API's answers.
 */
export function notificationPreferencesWithDefaults(
  preferences: UserNotificationPreferences | null | undefined
): Required<UserNotificationPreferences> {
  const stored = preferences?.emailCategories;
  const emailCategories = { ...DEFAULT_NOTIFICATION_EMAIL_CATEGORIES };
  for (const category of NOTIFICATION_EMAIL_CATEGORIES) {
    const value = stored?.[category];
    if (typeof value === 'boolean') emailCategories[category] = value;
  }
  return {
    watchPreference: preferences?.watchPreference || 'immediate',
    emailEnabled: preferences?.emailEnabled !== false,
    emailCategories
  };
}
