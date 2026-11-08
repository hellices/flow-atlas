using App;
using App.Clients;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddApiClients(builder.Configuration);
using var host = builder.Build();

var users = host.Services.GetRequiredService<UsersClient>();
var user = await users.GetUserAsync(1);
Console.WriteLine(user?.Name);
