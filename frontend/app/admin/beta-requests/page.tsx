import clientPromise from "../../lib/mongo";
import { getInviteStatus, normalizeEmail } from "../../lib/beta-invites";
import BetaRequestsClient, { BetaRequestRow } from "./beta-requests-client";

async function loadBetaRequests(): Promise<BetaRequestRow[]> {
  const now = new Date();
  const client = await clientPromise;
  const db = client.db();

  const requests = await db
    .collection("beta_interest_signups")
    .find({})
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray();

  const emails = requests
    .map((item) => normalizeEmail((item as any).email))
    .filter(Boolean);

  const [invites, users] = await Promise.all([
    emails.length
      ? db
          .collection("beta_invites")
          .find({ email: { $in: emails } })
          .sort({ createdAt: -1 })
          .toArray()
      : Promise.resolve([]),
    emails.length
      ? db
          .collection("users")
          .find({ email: { $in: emails } }, { projection: { email: 1 } })
          .toArray()
      : Promise.resolve([])
  ]);

  const latestInviteByEmail = new Map<string, any>();
  for (const invite of invites) {
    const email = normalizeEmail((invite as any).email);
    if (!email || latestInviteByEmail.has(email)) continue;
    latestInviteByEmail.set(email, invite);
  }

  const userEmailSet = new Set(users.map((u) => normalizeEmail((u as any).email)));

  return requests.map((request) => {
    const email = normalizeEmail((request as any).email);
    const invite = latestInviteByEmail.get(email);
    const inviteStatus = getInviteStatus(invite, now);

    return {
      email,
      description: String((request as any).description || ""),
      tosAcceptedAt: (request as any).tosAcceptedAt ? new Date((request as any).tosAcceptedAt).toISOString() : null,
      createdAt: (request as any).createdAt ? new Date((request as any).createdAt).toISOString() : null,
      updatedAt: (request as any).updatedAt ? new Date((request as any).updatedAt).toISOString() : null,
      accountExists: userEmailSet.has(email),
      inviteStatus: inviteStatus.value,
      inviteStatusLabel: inviteStatus.label,
      inviteSentAt: invite?.createdAt ? new Date(invite.createdAt).toISOString() : null,
      inviteExpiresAt: invite?.expiresAt ? new Date(invite.expiresAt).toISOString() : null,
      inviteUsedAt: invite?.usedAt ? new Date(invite.usedAt).toISOString() : null
    } satisfies BetaRequestRow;
  });
}

export default async function BetaRequestsPage() {
  const requests = await loadBetaRequests();

  return (
    <>
      <section className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Beta Request Inbox</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Review incoming beta requests and send one-time signup invites.
        </p>
      </section>

      <section className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
        <BetaRequestsClient initialRows={requests} />
      </section>
    </>
  );
}
