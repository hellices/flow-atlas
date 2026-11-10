using Carter;

namespace App.Modules;

// An ICarterModule that groups its routes itself, one group per version.
public class OrdersModule : ICarterModule
{
    public void AddRoutes(IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");
        foreach (var version in new[] { "v1", "v2" })
        {
            var orders = api.MapGroup($"/{version}/orders");
            orders.MapGet("/", () => "Orders");
            orders.MapGet("/{id:guid}", (Guid id) => $"Order {id}");
            orders.MapPost("/", () => Results.StatusCode(201));
        }
        app.MapGet("/files/{**path}", (string? path) => $"File {path}");
        app.Map("/echo", (HttpRequest req) => req.Method);
    }
}
