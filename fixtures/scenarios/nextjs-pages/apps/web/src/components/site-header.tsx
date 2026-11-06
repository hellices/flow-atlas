import Link from "next/link";

export function SiteHeader() {
  return (
    <nav aria-label="Main navigation">
      <Link href="/" className="nav-link">
        Home
      </Link>
      <Link href="/create" className="button">
        Write one
      </Link>
    </nav>
  );
}
