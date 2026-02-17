import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import clientPromise from "./mongo";

export class AdminAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

export async function requireAdminEmail(): Promise<string> {
  const session = await getServerSession(authOptions);
  const email = normalizeEmail(session?.user?.email);
  if (!email) {
    throw new AdminAuthError(401, "Authentication required");
  }

  const client = await clientPromise;
  const db = client.db();
  const user = await db.collection("users").findOne(
    { email },
    { projection: { roles: 1 } }
  );

  const roles = Array.isArray((user as any)?.roles) ? ((user as any).roles as string[]) : [];
  if (!roles.includes("admin")) {
    throw new AdminAuthError(403, "Admin role required");
  }

  return email;
}
