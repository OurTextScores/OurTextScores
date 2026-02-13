import { NextResponse } from "next/server";
import * as nodemailer from "nodemailer";
import clientPromise from "../../lib/mongo";

function clean(input: unknown): string {
  return String(input ?? "").trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const emailRaw = clean(body?.email);
  const description = clean(body?.description);
  const tosAccepted = body?.tosAccepted === true;

  if (!emailRaw) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!description) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  if (!tosAccepted) {
    return NextResponse.json({ error: "tosAccepted is required" }, { status: 400 });
  }

  const email = normalizeEmail(emailRaw);
  const now = new Date();
  const adminRecipient = process.env.BETA_PREVIEW_ADMIN_EMAIL || "admin@ourtextscores.com";
  const emailServer = process.env.EMAIL_SERVER;
  const emailFrom = process.env.EMAIL_FROM || "OurTextScores <noreply@ourtextscores.com>";

  // Persist a server-side record so sign-in can require TOS acknowledgement for new users.
  try {
    const client = await clientPromise;
    const db = client.db();
    await db.collection("beta_interest_signups").updateOne(
      { email },
      {
        $set: {
          email,
          description,
          tosAccepted: true,
          tosAcceptedAt: now,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: `Failed to save request: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }

  if (!emailServer) {
    return NextResponse.json({ error: "EMAIL_SERVER is not configured" }, { status: 503 });
  }

  try {
    const transport = nodemailer.createTransport(emailServer as any);
    const subject = `[OurTextScores Beta Preview] ${email}`;
    const text = [
      "New beta preview request",
      "",
      `Email: ${email}`,
      "",
      "Description / use case / potential contributions:",
      description,
      "",
      `Submitted at: ${now.toISOString()}`
    ].join("\n");

    await transport.sendMail({
      from: emailFrom,
      to: adminRecipient,
      replyTo: email,
      subject,
      text
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `Failed to send beta email: ${String(error?.message || error)}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
