using FastEndpoints;

namespace App.Features.Catalog;

// One verb on several routes.
public class ListProducts : EndpointWithoutRequest
{
    public override void Configure()
    {
        Get("/products", "/catalog/products");
    }

    public override async Task HandleAsync(CancellationToken ct) => await Send.OkAsync("products", ct);
}

public class ProductReviews : EndpointWithoutRequest
{
    public override void Configure()
    {
        Get("/products/{productId}/reviews");
    }

    public override async Task HandleAsync(CancellationToken ct) => await Send.OkAsync($"Reviews of {Route<string>("productId")}", ct);
}

// A catch-all route parameter.
public class DownloadFile : EndpointWithoutRequest
{
    public override void Configure()
    {
        Get("/files/{*path}");
    }

    public override async Task HandleAsync(CancellationToken ct) => await Send.OkAsync($"File {Route<string>("path", isRequired: false)}", ct);
}
