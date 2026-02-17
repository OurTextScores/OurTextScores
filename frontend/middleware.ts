import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = new Set<string>([
  "/welcome",
  "/catalogue",
  "/beta-preview",
  "/beta-invite",
  "/signin",
  "/tos",
  "/privacy",
  "/dmca",
  "/score-editor"
]);

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });

  if (PUBLIC_PATHS.has(pathname)) {
    if ((pathname === "/beta-preview" || pathname === "/signin") && token) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (!token) {
    const redirectUrl = new URL("/signin", request.url);
    const target = `${pathname}${search || ""}`;
    if (target && target !== "/") {
      redirectUrl.searchParams.set("next", target);
    }
    return NextResponse.redirect(redirectUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)"
  ]
};
