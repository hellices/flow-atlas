import { Switch, Redirect } from "react-router-dom";
import Route from "~/components/ProfiledRoute";
import Login from "~/scenes/Login";
import Logout from "~/scenes/Logout";
import Shared from "~/scenes/Shared";

export default function Routes() {
  return (
    <Switch>
      <Route exact path="/" component={Login} />
      <Route exact path="/logout" component={Logout} />
      <Redirect exact from="/share/:shareId" to="/s/:shareId" />
      <Route exact path="/s/:shareId" component={Shared} />
    </Switch>
  );
}
