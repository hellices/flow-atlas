using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace App.Clients;

// A typed client: AddHttpClient<UsersClient> hands it an HttpClient whose BaseAddress is the API's (".../api/").
public sealed class UsersClient(HttpClient httpClient)
{
    public Task<User?> GetUserAsync(int id) =>
        httpClient.GetFromJsonAsync<User>($"users/{id}");

    public Task<User[]?> ListUsersAsync(string role, int page) =>
        httpClient.GetFromJsonAsync<User[]>($"users?role={Uri.EscapeDataString(role)}&page={page}");

    public async Task<User?> CreateUserAsync(User user)
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync("users", user);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<User>();
    }

    public async Task ReplaceUserAsync(int id, User user)
    {
        using HttpResponseMessage response = await httpClient.PutAsync($"users/{id}", JsonContent.Create(user));
        response.EnsureSuccessStatusCode();
    }

    public async Task RenameUserAsync(int id, string name, int version)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"users/{id}")
        {
            Content = JsonContent.Create(new { name }),
        };
        request.Headers.IfMatch.Add(new EntityTagHeaderValue($"\"{version}\""));
        using HttpResponseMessage response = await httpClient.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    public async Task DeleteUserAsync(int id)
    {
        using HttpResponseMessage response = await httpClient.DeleteAsync($"users/{id}");
        response.EnsureSuccessStatusCode();
    }

    public Task<OrderItem[]?> GetOrderItemsAsync(string orderId) =>
        httpClient.GetFromJsonAsync<OrderItem[]>("orders/" + orderId + "/items");

    // A relative URI that starts with "/" replaces the base address's path: this is the server's own /health.
    public Task<string> HealthAsync() =>
        httpClient.GetStringAsync("/health");
}
