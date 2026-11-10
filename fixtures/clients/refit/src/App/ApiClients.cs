using App.Apis;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Refit;

namespace App;

public static class ApiClients
{
    // Every client's base address is the API's, from configuration (appsettings.json, or the environment: Services__Api).
    public static IServiceCollection AddApiClients(this IServiceCollection services, IConfiguration configuration)
    {
        var api = new Uri(configuration["Services:Api"]!);

        services.AddRefitClient<IUsersApi>()
            .ConfigureHttpClient(c => c.BaseAddress = api);
        services.AddRefitClient<IProjectsApi>()
            .ConfigureHttpClient(c => c.BaseAddress = api);

        // The generated implementation, with the JSON types from the source-generated context.
        services.AddRefitGeneratedClient<IReportsApi>(AppJsonContext.Default)
            .ConfigureHttpClient(c => c.BaseAddress = api);
        return services;
    }
}
