using FastEndpoints;

namespace App.Features.Orders;

public class OrderRequest
{
    public Guid OrderId { get; set; }
}

public record OrderResponse(Guid OrderId, string Status);

public class GetOrder : Endpoint<OrderRequest, OrderResponse>
{
    public override void Configure()
    {
        Get("/orders/{orderId:guid}");
    }

    public override async Task HandleAsync(OrderRequest req, CancellationToken ct) => await Send.OkAsync(new OrderResponse(req.OrderId, "open"), ct);
}

public class GetOrderV1 : Endpoint<OrderRequest, OrderResponse>
{
    public override void Configure()
    {
        Get("/orders/{orderId:guid}");
        Version(1, deprecateAt: 3);
    }

    public override async Task HandleAsync(OrderRequest req, CancellationToken ct) => await Send.OkAsync(new OrderResponse(req.OrderId, "v1"), ct);
}

// Fluent generics instead of the Endpoint<TRequest, TResponse> base.
public class ListOrders : Ep.NoReq.Res<List<OrderResponse>>
{
    public override void Configure()
    {
        Get("/orders");
    }

    public override async Task HandleAsync(CancellationToken ct) => await Send.OkAsync([], ct);
}

public class CreateOrder : Ep.Req<OrderRequest>.Res<OrderResponse>
{
    public override void Configure()
    {
        Post("/orders");
    }

    public override async Task HandleAsync(OrderRequest req, CancellationToken ct) => await Send.OkAsync(new OrderResponse(Guid.Empty, "new"), ct);
}
