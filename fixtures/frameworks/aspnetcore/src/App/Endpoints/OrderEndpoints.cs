namespace App.Endpoints;

public static class OrderEndpoints
{
    public static RouteGroupBuilder MapOrdersApi(this RouteGroupBuilder group)
    {
        var orders = group.MapGroup("/orders");
        orders.MapGet("", () => "All orders");
        orders.MapGet("{id:guid}", (Guid id) => $"Order {id}");
        orders.MapPost("", () => "Created");

        var lines = orders.MapGroup("/{orderId:guid}/lines");
        lines.MapGet("/", (Guid orderId) => $"Lines of {orderId}");
        lines.MapDelete("/{line:int}", (Guid orderId, int line) => $"Deleted line {line} of {orderId}");
        return group;
    }
}
