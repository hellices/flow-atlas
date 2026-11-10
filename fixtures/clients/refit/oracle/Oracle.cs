// Makes every request the app's Refit interfaces declare, once. The app's configuration (its appsettings.json, as the
// generic host loads it) names the API's base address; the oracle points it at the recording server in RECORD_URL,
// keeping its path, as an environment's settings would. The app registers its clients as it does at startup
// (AddApiClients, through Refit's IHttpClientFactory registrations); every method of each interface in App.Apis is
// then called on the implementation Refit registered, with ARG for each string and ARG_NUMBER for each number. A handler
// under every client counts what is sent, so each method must send exactly one request; only a failure to read the
// server's `{}` as the method's result type, after it was sent, is ignored.
using System.Reflection;
using System.Text;
using System.Text.Json;
using App;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Refit;

namespace Oracle;

public static class RequestOracle
{
    static readonly string Arg = Environment.GetEnvironmentVariable("ARG") ?? throw new InvalidOperationException("ARG is not set");
    static readonly int ArgNumber = int.Parse(Environment.GetEnvironmentVariable("ARG_NUMBER") ?? throw new InvalidOperationException("ARG_NUMBER is not set"));

    public static async Task<int> Main()
    {
        var record = new Uri(Environment.GetEnvironmentVariable("RECORD_URL") ?? throw new InvalidOperationException("RECORD_URL is not set"));
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { ContentRootPath = AppContext.BaseDirectory });
        builder.Logging.ClearProviders();
        var services = builder.Configuration.GetSection("Services").GetChildren().ToList();
        if (services.Count == 0) throw new InvalidOperationException("appsettings.json names no service under Services");
        foreach (var service in services)
            builder.Configuration[service.Path] = new Uri(record, new Uri(service.Value!).AbsolutePath).ToString();

        builder.Services.AddApiClients(builder.Configuration);
        builder.Services.ConfigureHttpClientDefaults(http => http.AddHttpMessageHandler(() => new CountingHandler()));
        using var host = builder.Build();

        var apis = typeof(ApiClients).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.IsInterface && t.Namespace == "App.Apis")
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();
        foreach (var type in apis)
        {
            var api = host.Services.GetRequiredService(type);
            foreach (var method in type.GetMethods().OrderBy(m => m.Name, StringComparer.Ordinal))
            {
                var before = CountingHandler.Sent;
                try
                {
                    var result = method.Invoke(api, method.GetParameters().Select(p => Value(p.ParameterType)).ToArray());
                    if (result is Task task) await task;
                }
                catch (Exception error) when (IsReading(error) && CountingHandler.Sent == before + 1)
                {
                    // The request was sent; the server's `{}` is not the array the method reads.
                }
                if (CountingHandler.Sent != before + 1)
                    throw new InvalidOperationException($"{type.Name}.{method.Name} sent {CountingHandler.Sent - before} requests");
            }
        }

        var refit = typeof(RestService).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion.Split('+')[0];
        Console.WriteLine(JsonSerializer.Serialize(new { library = "Refit", version = refit }));
        return 0;
    }

    static bool IsReading(Exception? error) => error switch
    {
        null => false,
        JsonException => true,
        _ => IsReading(error.InnerException),
    };

    /// <summary>ARG for a string, ARG_NUMBER for a number, and a model built from those for anything else.</summary>
    static object? Value(Type type)
    {
        if (type == typeof(string)) return Arg;
        if (type == typeof(int)) return ArgNumber;
        if (type == typeof(long)) return (long)ArgNumber;
        if (type == typeof(CancellationToken)) return CancellationToken.None;
        if (type == typeof(ByteArrayPart)) return new ByteArrayPart(Encoding.UTF8.GetBytes(Arg), Arg + ".txt");
        var constructor = type.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
        return constructor.Invoke(constructor.GetParameters().Select(p => Value(p.ParameterType)).ToArray());
    }

    sealed class CountingHandler : DelegatingHandler
    {
        static int sent;
        public static int Sent => sent;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref sent);
            return base.SendAsync(request, cancellationToken);
        }
    }
}
