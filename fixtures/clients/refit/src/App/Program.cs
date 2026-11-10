using App;
using App.Apis;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddApiClients(builder.Configuration);
using var host = builder.Build();

var users = host.Services.GetRequiredService<IUsersApi>();
var user = await users.GetUserAsync(1);
Console.WriteLine(user.Name);
