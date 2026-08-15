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

export const DEFAULT_NOTIFICATION_EMAIL_CATEGORIES: Record<
  NotificationEmailCategory,
  boolean
> = {
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

export function notificationPreferencesWithDefaults(
  preferences: UserNotificationPreferences | null | undefined
): Required<UserNotificationPreferences> {
  return {
    watchPreference: preferences?.watchPreference || 'immediate',
    emailEnabled: preferences?.emailEnabled !== false,
    emailCategories: {
      ...DEFAULT_NOTIFICATION_EMAIL_CATEGORIES,
      ...(preferences?.emailCategories || {})
    }
  };
}
