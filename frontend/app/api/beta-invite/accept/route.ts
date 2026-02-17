import { NextResponse } from "next/server";
import clientPromise from "../../../lib/mongo";
import { hashInviteToken } from "../../../lib/beta-invites";

function clean(input: unknown): string {
  return String(input ?? "").trim();
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const token = clean(body?.token);
  if (!token) {
    return NextResponse.json({ error: "Invite token is required" }, { status: 400 });
  }

  const now = new Date();
  const tokenHash = hashInviteToken(token);

  try {
    const client = await clientPromise;
    const db = client.db();

    const invite = await db.collection("beta_invites").findOne({
      tokenHash,
      usedAt: { $exists: false },
      revokedAt: { $exists: false },
      expiresAt: { $gt: now }
    });

    if (!invite?.email) {
      return NextResponse.json({ error: "Invite is invalid, expired, or already used" }, { status: 400 });
    }

    const email = String(invite.email).trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: "Invite email is invalid" }, { status: 400 });
    }

    const claimed = await db.collection("beta_invites").updateOne(
      {
        _id: invite._id,
        usedAt: { $exists: false },
        revokedAt: { $exists: false }
      },
      {
        $set: {
          usedAt: now,
          updatedAt: now
        }
      }
    );

    if (!claimed.modifiedCount) {
      return NextResponse.json({ error: "Invite has already been used" }, { status: 409 });
    }

    await db.collection("users").updateOne(
      { email },
      {
        $setOnInsert: {
          email,
          roles: ["user"],
          status: "active",
          enforcementStrikes: 0,
          notify: { watchPreference: "immediate" },
          createdAt: now
        },
        $set: {
          updatedAt: now
        }
      },
      { upsert: true }
    );

    await db.collection("beta_interest_signups").updateOne(
      { email },
      {
        $set: {
          inviteAcceptedAt: now,
          updatedAt: now
        }
      }
    );

    return NextResponse.json({ ok: true, email });
  } catch (error: any) {
    return NextResponse.json(
      { error: `Failed to accept invite: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
}
