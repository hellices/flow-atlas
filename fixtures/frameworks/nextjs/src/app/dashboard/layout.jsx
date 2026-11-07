// Parallel routes: the `@analytics` and `@team` slots render beside the page, at /dashboard.
export default function DashboardLayout({ children, analytics, team }) {
  return (
    <>
      {children}
      {analytics}
      {team}
    </>
  );
}
