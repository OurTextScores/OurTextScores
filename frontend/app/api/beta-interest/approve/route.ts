import { NextResponse } from "next/server";
import clientPromise from "../../../lib/mongo";
import { hashApprovalToken } from "../../../lib/beta-approvals";
import { isValidEmail, normalizeEmail, resolveInviteBaseUrl } from "../../../lib/beta-invites";
import { issueBetaInvite } from "../../../lib/beta-invite-service";

function clean(input: unknown): string {
  return String(input ?? "").trim();
}

async function findPendingSignupByToken(token: string) {
  const now = new Date();
  const tokenHash = hashApprovalToken(token);
  const client = await clientPromise;
  const db = client.db();
  const signup = await db.collection("beta_interest_signups").findOne({
    adminApprovalTokenHash: tokenHash,
    adminApprovalUsedAt: { $exists: false },
    adminApprovalExpiresAt: { $gt: now },
  });
  return { db, now, signup };
}

export async function GET(request: Request) {
  const token = clean(new URL(request.url).searchParams.get("token"));
  if (!token) {
    return NextResponse.json({ error: "Approval token is required" }, { status: 400 });
  }

  try {
    const { signup } = await findPendingSignupByToken(token);
    if (!signup?.email) {
      return NextResponse.json({ error: "Approval link is invalid, expired, or already used" }, { status: 400 });
    }

    const email = normalizeEmail(signup.email);
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "Approval email is invalid" }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      email,
      description: String(signup.description || ""),
      createdAt: signup.createdAt ? new Date(signup.createdAt).toISOString() : null,
      expiresAt: signup.adminApprovalExpiresAt ? new Date(signup.adminApprovalExpiresAt).toISOString() : null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `Failed to load approval request: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
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
    return NextResponse.json({ error: "Approval token is required" }, { status: 400 });
  }

  const emailServer = process.env.EMAIL_SERVER;
  if (!emailServer) {
    return NextResponse.json({ error: "EMAIL_SERVER is not configured" }, { status: 503 });
  }
  const emailFrom = process.env.EMAIL_FROM || "OurTextScores <noreply@ourtextscores.com>";

  try {
    const { db, now, signup } = await findPendingSignupByToken(token);
    if (!signup?._id || !signup.email) {
      return NextResponse.json({ error: "Approval link is invalid, expired, or already used" }, { status: 400 });
    }

    const email = normalizeEmail(signup.email);
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "Approval email is invalid" }, { status: 400 });
    }

    const claim = await db.collection("beta_interest_signups").updateOne(
      {
        _id: signup._id,
        adminApprovalUsedAt: { $exists: false },
        adminApprovalClaimedAt: { $exists: false },
      },
      {
        $set: {
          adminApprovalClaimedAt: now,
          updatedAt: now,
        },
      }
    );

    if (!claim.modifiedCount) {
      return NextResponse.json({ error: "Approval link has already been used" }, { status: 409 });
    }

    const actorLabel = clean(signup.adminApprovalIssuedTo) || "beta-request-email-link";

    try {
      const result = await issueBetaInvite({
        db,
        email,
        actorLabel,
        baseUrl: resolveInviteBaseUrl(request),
        emailServer,
        emailFrom,
        now,
      });

      await db.collection("beta_interest_signups").updateOne(
        { _id: signup._id },
        {
          $set: {
            adminApprovalUsedAt: now,
            approvedAt: now,
            approvedBy: actorLabel,
            updatedAt: now,
          },
          $unset: {
            adminApprovalClaimedAt: "",
            adminApprovalLastError: "",
          },
        }
      );

      return NextResponse.json({
        ok: true,
        email: result.email,
        expiresAt: result.expiresAt,
      });
    } catch (error: any) {
      await db.collection("beta_interest_signups").updateOne(
        { _id: signup._id },
        {
          $unset: {
            adminApprovalClaimedAt: "",
          },
          $set: {
            adminApprovalLastError: String(error?.message || error),
            updatedAt: new Date(),
          },
        }
      );
      throw error;
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: `Failed to approve beta request: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
}
