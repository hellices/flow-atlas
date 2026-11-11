import { Switch, Redirect } from "react-router-dom";
import Route from "~/components/ProfiledRoute";
import { Home } from "~/scenes/Home";
import DocumentNew from "~/scenes/DocumentNew";
import Search from "~/scenes/Search";
import { homePath, searchPath } from "~/utils/routeHelpers";

export default function AuthenticatedRoutes() {
  return (
    <Switch>
      <Route path={`${homePath()}/:tab?`} component={Home} />
      <Redirect from="/dashboard" to={homePath()} />
      <Route exact path="/doc/new" component={DocumentNew} />
      <Route exact path={`${searchPath()}/:query?`} component={Search} />
    </Switch>
  );
}
