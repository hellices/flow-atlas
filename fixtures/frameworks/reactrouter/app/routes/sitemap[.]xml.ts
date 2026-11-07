export function loader() {
  return new Response("<urlset/>", { headers: { "Content-Type": "application/xml" } });
}
