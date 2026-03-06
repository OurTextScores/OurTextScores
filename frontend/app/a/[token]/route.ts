import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const url = new URL("/beta-approve", request.url);
  url.searchParams.set("token", token);
  return NextResponse.redirect(url, 307);
}
