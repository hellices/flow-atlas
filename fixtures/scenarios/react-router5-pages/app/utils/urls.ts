export const isAllowedLoginRedirect = (input: string) => {
  const path = input.split("?")[0];
  return !["/", "/create", "/home", "/logout"].includes(path) && !path.startsWith("/auth/");
};
