// The routes of the App Router's file conventions (nextjs.org/docs/app/getting-started/project-structure): a folder
// is a segment, `page.jsx` serves it, `route.js` handles its requests; `[x]`, `[...x]` and `[[...x]]` are dynamic,
// `(x)` groups and `@x` slots add no segment, and a `_x` folder is private.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
