import Link from "next/link";

export function PostItem({ post }: { post: { id: string; title: string } }) {
  return <Link href={`/editor/${post.id}`}>{post.title}</Link>;
}
