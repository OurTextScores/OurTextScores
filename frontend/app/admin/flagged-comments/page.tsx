import { redirect } from "next/navigation";
import Link from "next/link";
import { getApiAuthHeaders } from "../../lib/authToken";
import { fetchBackendSession } from "../../lib/server-session";
import FlaggedCommentsClient from "./flagged-comments-client";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

interface FlaggedComment {
  commentId: string;
  workId: string;
  sourceId: string;
  revisionId: string;
  revisionSeq: number;
  content: string;
  userId: string;
  username?: string;
  flaggedBy?: string;
  flaggedByUsername?: string;
  flagReason?: string;
  flaggedAt?: Date;
  createdAt: Date;
  voteScore: number;
}

async function fetchFlaggedComments(): Promise<FlaggedComment[]> {
  const API = getBackendApiBase();
  const auth = await getApiAuthHeaders();

  try {
    const res = await fetch(`${API}/works/admin/flagged-comments`, {
      headers: {
        "Content-Type": "application/json",
        ...(auth.Authorization && { Authorization: auth.Authorization })
      },
      cache: "no-store"
    });

    if (!res.ok) {
      console.error("Failed to fetch flagged comments:", res.status);
      return [];
    }

    return res.json();
  } catch (err) {
    console.error("Error fetching flagged comments:", err);
    return [];
  }
}

export default async function FlaggedCommentsPage() {
  const session = await fetchBackendSession();

  // Check if user is admin
  if (!session?.user?.roles?.includes("admin")) {
    redirect("/");
  }

  const comments = await fetchFlaggedComments();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            ← Back to Home
          </Link>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 mb-6">
            Flagged Comments Dashboard
          </h1>

          {comments.length === 0 ? (
            <div className="text-center py-12 text-slate-500 dark:text-slate-400">
              No flagged comments at this time.
            </div>
          ) : (
            <>
              <div className="mb-4 text-sm text-slate-600 dark:text-slate-400">
                Total flagged comments: <strong>{comments.length}</strong>
              </div>

              <FlaggedCommentsClient initialComments={comments} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
