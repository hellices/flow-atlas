// The Pages Router beside the App Router (nextjs.org/docs/pages/building-your-application/routing): a file is a route,
// `index` its folder's, `[x]`, `[...x]` and `[[...x]]` dynamic; files under `pages/api` are API routes.
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
