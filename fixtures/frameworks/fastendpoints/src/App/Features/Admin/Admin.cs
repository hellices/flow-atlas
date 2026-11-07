using FastEndpoints;

namespace App.Features.Admin;

public class LoginRequest
{
    public string? UserName { get; set; }
    public string? Password { get; set; }
}

public record LoginResponse(string Token);

public class AdminLogin : Endpoint<LoginRequest, LoginResponse>
{
    public override void Configure()
    {
        Post("/login");
        Group<Administration>();
    }

    public override async Task HandleAsync(LoginRequest req, CancellationToken ct) => await Send.OkAsync(new LoginResponse("v0"), ct);
}

// The same route evolved: its version is appended to the route.
public class AdminLoginV1 : AdminLogin
{
    public override void Configure()
    {
        base.Configure();
        Version(1);
    }
}

public class AdminLoginV2 : Endpoint<LoginRequest, LoginResponse>
{
    public override void Configure()
    {
        Post("/login");
        Group<Administration>();
        Version(2);
    }

    public override async Task HandleAsync(LoginRequest req, CancellationToken ct) => await Send.OkAsync(new LoginResponse("v2"), ct);
}

public class InvoiceRequest
{
    public string? Id { get; set; }
}

public class GetInvoice : Endpoint<InvoiceRequest>
{
    public override void Configure()
    {
        Get("/invoice/{id}");
        Group<Sales>();
    }

    public override async Task HandleAsync(InvoiceRequest req, CancellationToken ct) => await Send.OkAsync($"Invoice {req.Id}", ct);
}

// Configured with attributes instead of Configure().
[HttpGet("/reports/{year:int}/{month:int?}")]
[Group<Sales>]
public class SalesReport : EndpointWithoutRequest
{
    public override async Task HandleAsync(CancellationToken ct) =>
        await Send.OkAsync($"Report {Route<int>("year")} {Route<int?>("month", isRequired: false)}", ct);
}
