"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  handleUpdateWatchPreference,
  type NotificationEmailCategories,
  type NotificationEmailCategory
} from "./actions";

const categoryLabels: Array<{
  id: NotificationEmailCategory;
  label: string;
  description: string;
}> = [
  { id: 'comments', label: 'Comments and replies', description: 'Activity on your scores and comments.' },
  { id: 'revisions', label: 'New revisions', description: 'Updates to scores you watch.' },
  { id: 'reviews', label: 'Change reviews', description: 'Review submissions and discussion activity.' },
  { id: 'scanner', label: 'Scanner jobs', description: 'Completed, partially completed, or failed scans.' },
  { id: 'approvals', label: 'Approval requests', description: 'Revisions waiting for your decision.' }
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 rounded bg-cyan-600 px-3 py-1 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
    >
      {pending ? "Saving..." : "Save"}
    </button>
  );
}

export function NotificationsForm({
  preference,
  emailEnabled,
  emailCategories
}: {
  preference: 'immediate' | 'daily' | 'weekly';
  emailEnabled: boolean;
  emailCategories: NotificationEmailCategories;
}) {
  const [state, formAction] = useFormState(handleUpdateWatchPreference, null);
  const [enabled, setEnabled] = useState(emailEnabled);

  return (
    <form data-testid="settings-form" action={formAction}>
      <label className="flex items-start gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
        <input
          className="mt-0.5"
          type="checkbox"
          name="emailEnabled"
          defaultChecked={emailEnabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        <span>
          <span className="block font-medium">Send me notification emails</span>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Turn this off to unsubscribe from every notification email. In-app notifications stay on.
          </span>
        </span>
      </label>

      <fieldset className={`mt-5 ${enabled ? '' : 'opacity-60'}`}>
        <legend className="font-medium">Email categories</legend>
        <p className="mb-3 mt-1 text-xs text-slate-500 dark:text-slate-400">
          Choose which kinds of activity may be emailed when notification emails are enabled.
        </p>
        <div className="space-y-3">
          {categoryLabels.map((category) => (
            <label key={category.id} className="flex items-start gap-3">
              <input
                className="mt-0.5"
                type="checkbox"
                name={`emailCategory_${category.id}`}
                defaultChecked={emailCategories[category.id]}
              />
              <span>
                <span className="block">{category.label}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {category.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={`mt-5 ${enabled ? '' : 'opacity-60'}`}>
        <legend className="font-medium">Email frequency</legend>
        <div className="mt-2 space-y-2">
          {(['immediate', 'daily', 'weekly'] as const).map((opt) => (
            <label key={opt} className="flex items-center gap-2">
              <input type="radio" name="watchPreference" value={opt} defaultChecked={preference === opt} />
              <span>
                {opt === 'daily' ? 'Daily Batch' : opt === 'weekly' ? 'Weekly Batch' : 'Immediate'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state?.success === true && (
        <div className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
          Notification preferences updated!
        </div>
      )}

      {state?.success === false && (
        <div className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
          {state.error || 'Failed to update preferences'}
        </div>
      )}

      <SubmitButton />
    </form>
  );
}
