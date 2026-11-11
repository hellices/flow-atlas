export const AppPaths = {
  settings: () => "/settings",
  record: ({ objectNameSingular, id }: { objectNameSingular: string; id: string }) => `/object/${objectNameSingular}/${id}`,
};
