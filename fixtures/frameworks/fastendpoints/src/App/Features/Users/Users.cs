using FastEndpoints;

namespace App.Features.Users;

public class UserRequest
{
    public int Id { get; set; }
    public string? Name { get; set; }
}

public record UserResponse(int Id, string Name);

public class CreateUser : Endpoint<UserRequest, UserResponse>
{
    public override void Configure()
    {
        Post("/users");
    }

    public override async Task HandleAsync(UserRequest req, CancellationToken ct) =>
        await Send.OkAsync(new UserResponse(1, req.Name ?? "new"), ct);
}

public class ListUsers : EndpointWithoutRequest<List<UserResponse>>
{
    public override void Configure()
    {
        Get("/users");
    }

    public override async Task HandleAsync(CancellationToken ct) =>
        await Send.OkAsync([new UserResponse(1, "one")], ct);
}

public class GetUser : Endpoint<UserRequest, UserResponse>
{
    public override void Configure()
    {
        Get("/users/{id:int}");
    }

    public override async Task HandleAsync(UserRequest req, CancellationToken ct) =>
        await Send.OkAsync(new UserResponse(req.Id, "one"), ct);
}

// Several verbs on several routes.
public class SaveUser : Endpoint<UserRequest, UserResponse>
{
    public override void Configure()
    {
        Verbs(Http.PUT, Http.PATCH);
        Routes("/users/{id:int}", "/members/{id:int}");
    }

    public override async Task HandleAsync(UserRequest req, CancellationToken ct) =>
        await Send.OkAsync(new UserResponse(req.Id, req.Name ?? "saved"), ct);
}

public class DeleteUser : Endpoint<UserRequest>
{
    public override void Configure()
    {
        Delete("/users/{id:int}");
    }

    public override async Task HandleAsync(UserRequest req, CancellationToken ct) => await Send.NoContentAsync(ct);
}

// The global prefix replaced for one endpoint, and left out for another.
public class CreateMobileUser : Endpoint<UserRequest, UserResponse>
{
    public override void Configure()
    {
        Post("user/create");
        RoutePrefixOverride("mobile");
    }

    public override async Task HandleAsync(UserRequest req, CancellationToken ct) =>
        await Send.OkAsync(new UserResponse(1, req.Name ?? "mobile"), ct);
}

public class Ping : EndpointWithoutRequest
{
    public override void Configure()
    {
        Get("/ping");
        RoutePrefixOverride(string.Empty);
    }

    public override async Task HandleAsync(CancellationToken ct) => await Send.OkAsync("pong", ct);
}
