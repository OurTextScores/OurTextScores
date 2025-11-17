import { createHmac } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signHs256(data: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(data).digest();
  return b64url(sig);
}

export async function getApiAuthHeaders(): Promise<Record<string, string>> {
  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.email) {
    return {};
  }
  const email = session.user.email;
  const name = session.user.name;
  const secret = process.env.NEXTAUTH_SECRET || "dev-secret";
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60; // 1 hour

  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = { sub: email, email, name, iat: now, exp };
  const encodedHeader = b64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = b64url(Buffer.from(JSON.stringify(payload)));
  const signature = signHs256(`${encodedHeader}.${encodedPayload}`, secret);
  const token = `${encodedHeader}.${encodedPayload}.${signature}`;
  return { Authorization: `Bearer ${token}` };
}
