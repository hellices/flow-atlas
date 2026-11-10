// A module's own helper around fetch, as an app keeps one for its headers and errors.
async function request(path, init = {}) {
  const response = await fetch(`/api${path}`, { ...init, headers: { Accept: "application/json", ...init.headers } });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

export const listProjects = () => request("/projects");
export const getProject = (id) => request(`/projects/${id}`);
export const archiveProject = (id) => request(`/projects/${id}/archive`, { method: "POST" });
export const deleteProject = (id) => request(`/projects/${id}`, { method: "DELETE" });
