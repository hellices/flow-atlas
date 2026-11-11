import { Navigate, Route, Routes } from "react-router-dom";

// Legacy settings paths redirect to where their pages are now.
const LEGACY_PREFIX = "mcp-apis";

const LEGACY_PATHS = [
  { suffix: "", to: "developers" },
  { suffix: "/apis/new", to: "developers/api-keys/new" },
  { suffix: "/webhooks/:webhookId", to: "developers/webhooks/:webhookId" },
] as const;

export const SettingsRoutes = () => (
  <Routes>
    {LEGACY_PATHS.map(({ suffix, to }) => (
      <Route key={suffix} path={`${LEGACY_PREFIX}${suffix}`} element={<Navigate to={`/settings/${to}`} replace />} />
    ))}
  </Routes>
);
