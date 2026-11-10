using Refit;

namespace App.Apis;

// [PathPrefix] puts its path before every route of the interface.
[PathPrefix("/projects")]
public interface IProjectsApi
{
    [Get("/{id}")]
    Task<Project> GetProjectAsync(string id);

    [Post("/{id}/archive")]
    Task ArchiveProjectAsync(string id, [Authorize("Bearer")] string token);

    [Get("/{project.Id}/members")]
    Task<List<User>> GetMembersAsync(Project project);

    [Get("/{id}/files/{**path}")]
    Task<HttpResponseMessage> DownloadFileAsync(string id, string path);

    [Multipart]
    [Post("/{id}/files")]
    Task UploadFileAsync(string id, [AliasAs("file")] ByteArrayPart file);
}
