const nonSplitViewPrefixes = ["/api", "/settings", "/s", "/share", "/login", "/logout", "/404"];

export function isSplittablePath(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    return false;
  }
  return !nonSplitViewPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
