using FastEndpoints;

var bld = WebApplication.CreateBuilder(args);
bld.Services.AddFastEndpoints();

var app = bld.Build();
app.UseFastEndpoints(c =>
{
    // Every route under /api, unless an endpoint overrides the prefix.
    c.Endpoints.RoutePrefix = "api";
    c.Endpoints.Configurator = ep => ep.AllowAnonymous();
    // An endpoint with a version gets it appended to its route: v1, v2.
    c.Versioning.Prefix = "v";
});

app.Run();
