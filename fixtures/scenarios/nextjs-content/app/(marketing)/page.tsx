import Link from "next/link";

export default function IndexPage() {
  return (
    <section>
      <h1>Write, edit and publish notes.</h1>
      <Link href="/register">Get started</Link>
    </section>
  );
}
