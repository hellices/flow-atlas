import { Redirect, useHistory, useRouteMatch } from "react-router-dom";

export function Home({ tab }: { tab: string }) {
  const history = useHistory();
  const isIndex = !!useRouteMatch({ path: "/home", exact: true });
  const redirectTo = isIndex && tab !== "recent" ? `/home/${tab}` : undefined;
  const onEmptied = () => history.push("/trash");

  return redirectTo ? <Redirect to={redirectTo} /> : <button onClick={onEmptied}>Empty trash</button>;
}
