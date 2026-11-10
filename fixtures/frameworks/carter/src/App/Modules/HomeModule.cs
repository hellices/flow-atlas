using Carter;
using Carter.ModelBinding;
using Carter.Request;
using Carter.Response;

namespace App.Modules;

public class HomeModule : ICarterModule
{
    public void AddRoutes(IEndpointRouteBuilder app)
    {
        app.MapGet("/", () => "Hello from Carter!");
        app.MapGet("/qs", (HttpRequest req) => $"It's {string.Join(",", req.Query.AsMultiple<int>("ids"))}");
        app.MapGet("/conneg", (HttpResponse res) => res.Negotiate(new { Name = "Dave" }));
        app.MapFormPost("/formpost", (Person person) => TypedResults.Ok(person)).DisableAntiforgery();
        app.MapGet("/errorhandler", () => Results.Problem("Something went wrong"));
    }
}

public static class NestedHomeModule
{
    // A module nested in a class is found as well.
    public class HomeModule : ICarterModule
    {
        public void AddRoutes(IEndpointRouteBuilder app)
        {
            app.MapGet("/nestedHome", () => "Hello from a nested module!");
        }
    }
}
