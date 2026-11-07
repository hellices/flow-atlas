import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const signedIn = req.cookies.has("session");
  if (!signedIn && req.nextUrl.pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/editor/:path*", "/login"],
};
