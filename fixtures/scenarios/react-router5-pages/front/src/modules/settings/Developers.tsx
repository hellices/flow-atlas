import { getDocumentationUrl } from "@/support/getDocumentationUrl";

export const Developers = ({ locale }: { locale?: string }) => (
  <button onClick={() => window.open(getDocumentationUrl({ locale, path: "/developers/extend/apps/getting-started" }))}>
    Documentation
  </button>
);
