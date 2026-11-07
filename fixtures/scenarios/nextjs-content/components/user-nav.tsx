import Link from "next/link";

export function UserNav({ signedIn }: { signedIn: boolean }) {
  return <Link href={signedIn ? "/dashboard" : "/login"}>{signedIn ? "Dashboard" : "Login"}</Link>;
}
