import { NextResponse } from "next/server";
import clientPromise from "../../../lib/mongo";
import { AdminAuthError, requireAdminEmail } from "../../../lib/admin-auth";
import {
  isValidEmail,
  normalizeEmail,
  resolveInviteBaseUrl
} from "../../../lib/beta-invites";
import { issueBetaInvite } from "../../../lib/beta-invite-service";

function clean(input: unknown): string {
  return String(input ?? "").trim();
}

export async function POST(request: Request) {
  try {
    const adminEmail = await requireAdminEmail();

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const email = normalizeEmail(clean(body?.email));
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }

    const emailServer = process.env.EMAIL_SERVER;
    if (!emailServer) {
      return NextResponse.json({ error: "EMAIL_SERVER is not configured" }, { status: 503 });
    }
    const emailFrom = process.env.EMAIL_FROM || "OurTextScores <noreply@ourtextscores.com>";

    const baseUrl = resolveInviteBaseUrl(request);

    const client = await clientPromise;
    const db = client.db();
    const result = await issueBetaInvite({
      db,
      email,
      actorLabel: adminEmail,
      baseUrl,
      emailServer,
      emailFrom,
    });

    return NextResponse.json({
      ok: true,
      email: result.email,
      expiresAt: result.expiresAt,
    });
  } catch (error: any) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      { error: `Failed to send invite: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const adminEmail = await requireAdminEmail();

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const email = normalizeEmail(clean(body?.email));
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }

    const now = new Date();
    const client = await clientPromise;
    const db = client.db();

    const result = await db.collection("beta_invites").updateMany(
      {
        email,
        usedAt: { $exists: false },
        revokedAt: { $exists: false }
      },
      {
        $set: {
          revokedAt: now,
          revokedBy: adminEmail,
          updatedAt: now
        }
      }
    );

    await db.collection("beta_interest_signups").updateOne(
      { email },
      {
        $set: {
          updatedAt: now
        },
        $unset: {
          invitedAt: "",
          invitedBy: ""
        }
      }
    );

    return NextResponse.json({
      ok: true,
      email,
      revokedCount: result.modifiedCount
    });
  } catch (error: any) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      { error: `Failed to revoke invite: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
}
