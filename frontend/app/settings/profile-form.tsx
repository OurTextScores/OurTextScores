"use client";

import { useFormState, useFormStatus } from "react-dom";
import { handleUpdateProfile } from "./actions";

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

export function ProfileForm({ email, username }: { email: string; username?: string }) {
  const [state, formAction] = useFormState(handleUpdateProfile, null);

  return (
    <form data-testid="profile-form" action={formAction}>
      <div className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Email
          </label>
          <input
            type="email"
            id="email"
            value={email}
            disabled
            className="w-full rounded border border-slate-300 bg-slate-100 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Email cannot be changed</p>
        </div>

        <div>
          <label htmlFor="username" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Username
          </label>
          <input
            type="text"
            id="username"
            name="username"
            defaultValue={username || ''}
            pattern="[a-z0-9_]{3,20}"
            placeholder="username (3-20 chars, lowercase, a-z 0-9 _)"
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Lowercase letters, numbers, and underscores only. 3-20 characters.</p>
        </div>
      </div>

      {state?.success === true && (
        <div className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
          Profile updated successfully!
        </div>
      )}

      {state?.success === false && (
        <div className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
          {state.error || 'Failed to update profile'}
        </div>
      )}

      <SubmitButton />
    </form>
  );
}
