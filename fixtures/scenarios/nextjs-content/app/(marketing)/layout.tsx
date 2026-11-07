import Link from "next/link";
import { UserNav } from "../../components/user-nav";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header>
        <Link href="/pricing">Pricing</Link>
        <UserNav signedIn={false} />
      </header>
      <main>{children}</main>
    </div>
  );
}
