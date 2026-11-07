using Carter;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCarter();

var app = builder.Build();

// A route of a module handles the errors of the others.
app.UseExceptionHandler("/errorhandler");

app.MapCarter();
app.Run();
