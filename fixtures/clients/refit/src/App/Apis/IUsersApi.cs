using Refit;

namespace App.Apis;

[Headers("Accept: application/json", "User-Agent: app/1.0")]
public interface IUsersApi
{
    [Get("/users/{id}")]
    Task<User> GetUserAsync(int id);

    [Get("/users")]
    Task<List<User>> ListUsersAsync([Query] string role, int page);

    [Get("/users/search?active=true")]
    Task<List<User>> SearchUsersAsync([AliasAs("q")] string name);

    [Post("/users")]
    Task<User> CreateUserAsync([Body] User user);

    [Put("/users/{id}")]
    Task ReplaceUserAsync(int id, [Body] User user);

    [Patch("/users/{id}")]
    Task RenameUserAsync(int id, [Body] Rename rename, [Header("If-Match")] string etag);

    [Delete("/users/{id}")]
    Task DeleteUserAsync(int id);

    [Head("/users/{id}")]
    Task<IApiResponse> UserExistsAsync(int id);

    [Get("/orders/{orderId}/items")]
    Task<List<OrderItem>> GetOrderItemsAsync(string orderId);
}
