"use client";

import { useFormState, useFormStatus } from "react-dom";
import { handleUpdateWatchPreference } from "./actions";

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

export function NotificationsForm({ preference }: { preference: 'immediate' | 'daily' | 'weekly' }) {
  const [state, formAction] = useFormState(handleUpdateWatchPreference, null);

  return (
    <form data-testid="settings-form" action={formAction}>
      <div className="space-y-2">
        {(['immediate', 'daily', 'weekly'] as const).map((opt) => (
          <label key={opt} className="flex items-center gap-2">
            <input type="radio" name="watchPreference" value={opt} defaultChecked={preference === opt} />
            <span className="capitalize">{opt}</span>
          </label>
        ))}
      </div>

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
