using App.Endpoints;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddHealthChecks();

var app = builder.Build();

// Served by the framework: the files of wwwroot, the OpenAPI document and a health check.
app.MapStaticAssets();
app.MapOpenApi();
app.MapHealthChecks("/healthz");

// One path, several methods.
app.MapGet("/", () => "This is a GET");
app.MapPost("/", () => "This is a POST");
app.MapPut("/", () => "This is a PUT");
app.MapDelete("/", () => "This is a DELETE");
app.MapMethods("/options-or-head", new[] { "OPTIONS", "HEAD" }, () => "This is an options or head request");
app.MapMethods("/ping", new[] { "GET", "PATCH" }, () => "pong");
app.Map("/any", () => "Any method");

// Parameters, constraints, optional and default values, catch-all segments.
app.MapGet("/users/{userId}/books/{bookId}", (int userId, int bookId) => $"The user id is {userId} and book id is {bookId}");
app.MapGet("/hello/{name:alpha}", (string name) => $"Hello {name}");
app.MapGet("/todos/{id:int}", (int id) => $"Todo {id}");
app.MapGet("/todos/{text}", (string text) => $"Todos about {text}");
app.MapGet("/posts/{slug:regex(^[a-z0-9_-]+$)}", (string slug) => $"Post {slug}");
app.MapGet("/posts/{*rest}", (string rest) => $"Routing to {rest}");
app.MapGet("/wiki/{**path}", (string path) => $"Wiki {path}");
app.MapGet("/files/{filename}.{ext?}", (string filename, string? ext) => $"{filename} {ext}");
app.MapGet("/pages/{page=Home}", (string page) => $"Page {page}");
app.MapGet("/archive/{year:int:min(2000)}/{month:range(1,12)?}", (int year, int? month) => $"{year} {month}");
app.MapPatch("/search/{term:minlength(3)}", (string term) => $"Search {term}");

// Groups, nested groups, a group per version, endpoints defined in other files.
app.MapGroup("/public/todos").MapTodosApi();
app.MapGroup("/private/todos").MapTodosApi();

var api = app.MapGroup("/api");
api.MapGroup("/v1").MapOrdersApi();
var v2 = api.MapGroup("v2");
v2.MapOrdersApi();
v2.MapGet("/status", () => "ok");

TenantEndpoints.Map(app);

// Controllers: attribute routes, and conventional routes for the controllers that have none.
app.MapControllers();
app.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
