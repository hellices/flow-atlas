import { PostCreateButton } from "../../../components/post-create-button";
import { PostItem } from "../../../components/post-item";

export default function DashboardPage() {
  return (
    <div>
      <PostCreateButton />
      <PostItem post={{ id: "first", title: "First" }} />
    </div>
  );
}
