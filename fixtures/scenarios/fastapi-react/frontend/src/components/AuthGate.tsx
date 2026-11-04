import { authFetch } from "../lib/auth";

export function AuthGate({ template }: { template: string }) {
  const check = () => authFetch("/api/auth/session");
  const logout = () => authFetch("/api/auth/logout", { method: "POST" });
  const rules = () => authFetch(`/api/templates/${encodeURIComponent(template)}`);
  return null;
}
