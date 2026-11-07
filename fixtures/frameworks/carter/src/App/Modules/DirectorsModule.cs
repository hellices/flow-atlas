using Carter;

namespace App.Modules;

#pragma warning disable CS0618 // CarterModule is obsolete in favour of ICarterModule, and still supported.
// A module with a base path its routes are mapped under.
public class DirectorsModule : CarterModule
{
    public DirectorsModule() : base("/directors")
    {
        WithTags("Directors");
    }

    public override void AddRoutes(IEndpointRouteBuilder app)
    {
        app.MapGet("/", () => "Directors");
        app.MapPost("/", (Person person) => Results.Created($"/directors/{person.Name}", person));
        app.MapPut<Person>("/", (Person person) => "PUT");
        app.MapGet("/qs", (string name, int[] numbers) => name + string.Join(",", numbers));
        app.MapGet("/{id:int}", (int id) => $"Director {id}");
        app.MapPost<Person>("/{id:int}/films", (int id, Person person) => Results.NoContent());
    }
}

// A base path with a parameter, and groups within the module.
public class TenantsModule : CarterModule
{
    public TenantsModule() : base("/tenants/{tenantId}")
    {
    }

    public override void AddRoutes(IEndpointRouteBuilder app)
    {
        app.MapGet("/", (string tenantId) => $"Tenant {tenantId}");
        app.MapGet("/projects/{projectId?}", (string tenantId, string? projectId) => $"{tenantId} {projectId}");

        var settings = app.MapGroup("/settings");
        settings.MapGet("/", (string tenantId) => "Settings");
        settings.MapMethods("/", ["PUT", "PATCH"], (string tenantId) => "Saved");
    }
}
#pragma warning restore CS0618
