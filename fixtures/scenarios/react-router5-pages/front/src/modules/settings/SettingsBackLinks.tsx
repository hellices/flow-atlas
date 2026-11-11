import { Link, useNavigate } from "react-router-dom";
import { AppPaths } from "@/app/AppPaths";

export const SettingsBackLinks = ({ id }: { id: string }) => {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(AppPaths.settings())}>Back</button>
      <Link to={AppPaths.record({ objectNameSingular: "company", id })}>Company</Link>
    </>
  );
};
