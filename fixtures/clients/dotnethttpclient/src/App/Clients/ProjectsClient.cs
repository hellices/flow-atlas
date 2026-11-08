using System.Net.Http.Json;

namespace App.Clients;

// A typed client that keeps its resource's path in a constant.
public sealed class ProjectsClient(HttpClient httpClient)
{
    private const string Projects = "projects";

    public Task<Project[]?> ListProjectsAsync() =>
        httpClient.GetFromJsonAsync<Project[]>(Projects);

    public async Task ArchiveProjectAsync(string id)
    {
        using HttpResponseMessage response = await httpClient.PostAsync($"{Projects}/{id}/archive", content: null);
        response.EnsureSuccessStatusCode();
    }

    public async Task RenameProjectAsync(string id, string name)
    {
        using HttpResponseMessage response = await httpClient.PatchAsJsonAsync($"{Projects}/{id}", new { name });
        response.EnsureSuccessStatusCode();
    }

    public async Task UploadAsync(string id, string fileName)
    {
        using var form = new MultipartFormDataContent();
        form.Add(new StringContent("file contents"), "file", fileName);
        using HttpResponseMessage response = await httpClient.PostAsync(Projects + "/" + id + "/files", form);
        response.EnsureSuccessStatusCode();
    }
}
