import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://notebook.example.com", lastModified: new Date() }];
}
