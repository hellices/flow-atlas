import { Navigate, Route, Routes, generatePath, useParams } from "react-router-dom";

// Legacy settings paths redirect to where their pages are now, with the values of their parameters.
const LEGACY_PREFIX = "mcp-apis";

const LEGACY_PATHS = [
  { suffix: "", to: "developers" },
  { suffix: "/apis/new", to: "developers/api-keys/new" },
  { suffix: "/webhooks/:webhookId", to: "developers/webhooks/:webhookId" },
] as const;

const LegacySettingsPathRedirect = ({ to }: { to: string }) => {
  const params = useParams();
  return <Navigate to={generatePath(`/settings/${to}`, params)} replace />;
};

export const SettingsRoutes = () => (
  <Routes>
    {LEGACY_PATHS.map(({ suffix, to }) => (
      <Route key={suffix} path={`${LEGACY_PREFIX}${suffix}`} element={<LegacySettingsPathRedirect to={to} />} />
    ))}
  </Routes>
);
