import { useRouter } from "next/router";

export default function PostPage() {
  return <h1>{useRouter().query.id}</h1>;
}
