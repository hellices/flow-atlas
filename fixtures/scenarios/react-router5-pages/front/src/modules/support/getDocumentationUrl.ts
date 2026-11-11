import { DOCUMENTATION_BASE_URL } from "../../../../shared/constants";

export const getDocumentationUrl = ({ locale, path = "/" }: { locale?: string; path?: string }): string => {
  if (!locale || locale.startsWith("en")) {
    return `${DOCUMENTATION_BASE_URL}${path}`;
  }
  return `${DOCUMENTATION_BASE_URL}/${locale}${path}`;
};
