using Carter;
using Carter.ModelBinding;
using Carter.Request;
using Carter.Response;

namespace App.Modules;

public class ActorsModule : ICarterModule
{
    public void AddRoutes(IEndpointRouteBuilder app)
    {
        app.MapGet("/actors", () => Results.Ok(Array.Empty<Person>()));
        app.MapGet("/actors/{id:int}", (int id) => Results.Ok(new Person($"Actor {id}")));
        app.MapPost("/actors", (HttpContext ctx, Person person) =>
        {
            var result = ctx.Request.Validate(person);
            return result.IsValid ? Results.StatusCode(201) : Results.UnprocessableEntity(result.GetFormattedErrors());
        });
        app.MapPut("/actors/{id:int}", (int id, Person person) => Results.NoContent());
        app.MapDelete("/actors/{id:int}", (int id) => Results.NoContent());
    }
}
