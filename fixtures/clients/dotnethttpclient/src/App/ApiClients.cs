using System.Net.Http.Headers;
using App.Clients;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace App;

public static class ApiClients
{
    public const string Reports = "reports";

    // The clients' base addresses come from configuration (appsettings.json, or the environment: Services__Api). Each
    // ends in `/`, so a relative URI without a leading `/` is resolved under the base address's path.
    public static IServiceCollection AddApiClients(this IServiceCollection services, IConfiguration configuration)
    {
        // Typed clients: each gets an HttpClient configured here in its constructor.
        services.AddHttpClient<UsersClient>(client =>
        {
            client.BaseAddress = new Uri(configuration["Services:Api"]!);
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        });
        services.AddHttpClient<ProjectsClient>(client => client.BaseAddress = new Uri(configuration["Services:Api"]!));

        // A named client, created by name from IHttpClientFactory.
        services.AddHttpClient(Reports, client =>
        {
            client.BaseAddress = new Uri(configuration["Services:Reports"]!);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("app/1.0");
        });
        services.AddTransient<ReportsService>();
        return services;
    }
}
