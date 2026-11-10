namespace App.Endpoints;

public static class TodoEndpoints
{
    public static RouteGroupBuilder MapTodosApi(this RouteGroupBuilder group)
    {
        group.MapGet("/", () => "All todos");
        group.MapGet("/{id}", (int id) => $"Todo {id}");
        group.MapPost("/", () => "Created");
        group.MapPut("/{id}", (int id) => $"Updated {id}");
        group.MapDelete("/{id}", (int id) => $"Deleted {id}");
        return group;
    }
}
