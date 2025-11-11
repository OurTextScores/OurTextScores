import { NextResponse } from "next/server";
import * as nodemailer from "nodemailer";
import clientPromise from "../../../lib/mongo";

export async function GET() {
  const startedAt = Date.now();
  const EMAIL_SERVER = process.env.EMAIL_SERVER || "";
  const EMAIL_FROM = process.env.EMAIL_FROM || "";
  const MONGO_URI = process.env.MONGO_URI || "";

  const email: any = {
    configured: !!(EMAIL_SERVER && EMAIL_FROM),
    verify: undefined as undefined | { ok: true; response?: string } | { ok: false; error: string }
  };
  const db: any = {
    configured: !!MONGO_URI,
    connected: undefined as undefined | boolean,
    error: undefined as undefined | string
  };

  // SMTP verify (does not send mail)
  if (email.configured) {
    try {
      const transport = nodemailer.createTransport(EMAIL_SERVER as any);
      await transport.verify();
      email.verify = { ok: true };
    } catch (err: any) {
      email.verify = { ok: false, error: String(err?.message || err) };
    }
  }

  // Mongo adapter connectivity
  if (db.configured) {
    try {
      const client = await clientPromise;
      const admin = client.db().admin();
      // ping throws if not connected
      await admin.ping();
      db.connected = true;
    } catch (err: any) {
      db.connected = false;
      db.error = String(err?.message || err);
    }
  }

  const durationMs = Date.now() - startedAt;
  const statusCode = email.configured && (!email.verify || (email.verify as any).ok) && (!db.configured || db.connected)
    ? 200
    : 503;

  return NextResponse.json(
    {
      ok: statusCode === 200,
      email,
      db,
      durationMs
    },
    { status: statusCode }
  );
}
