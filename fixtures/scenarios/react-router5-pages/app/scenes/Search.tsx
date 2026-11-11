import { searchPath } from "~/utils/routeHelpers";

export default function Search() {
  return (
    <form method="GET" action={searchPath()}>
      <input name="query" />
    </form>
  );
}
