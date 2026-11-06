interface Workspace {
  id: string;
  path: string;
}

interface Release {
  tag_name: string;
  html_url: string;
}

// A release to show the update banner with while the banner is designed.
export const SAMPLE_RELEASE: Release = {
  tag_name: "v9.0.0",
  html_url: "https://example.com/acme/notes-desktop/releases",
};

export async function openWorkspace(workspace: Workspace): Promise<void> {
  saveImportSettings({
    enabled: false,
    path: `${workspace.path}/raw/sources`,
    interval: 60,
  });
  await fetch("http://127.0.0.1:4800/workspace", {
    method: "POST",
    body: JSON.stringify({ id: workspace.id, path: workspace.path }),
  });
}

declare function saveImportSettings(settings: { enabled: boolean; path: string; interval: number }): void;
