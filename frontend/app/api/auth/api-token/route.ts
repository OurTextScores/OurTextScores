import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../lib/authToken";

export async function GET() {
  const headers = await getApiAuthHeaders();
  const auth = (headers as any).Authorization as string | undefined;
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = auth.replace(/^Bearer\s+/i, "");
  return NextResponse.json({ token });
}
