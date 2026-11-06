export function createStoreObjects(options: { baseUrl: string; fetch: typeof fetch }) {
  const base = `${options.baseUrl.replace(/\/+$/, "")}/store/internal/object-info/`;
  const path = (storageRef: string) => storageRef.split("/").map(encodeURIComponent).join("/");
  return {
    async describe(storageRef: string) {
      const response = await options.fetch(`${base}${path(storageRef)}`, { headers: { accept: "application/json" } });
      return response.json();
    },
  };
}
