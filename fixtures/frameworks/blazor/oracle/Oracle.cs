// Asks Blazor, through ASP.NET Core, which routes the application serves. MapRazorComponents gives ASP.NET Core's endpoint
// routing an endpoint for each route template of each routable component (@page) in the application's assembly and the
// additional ones, beside the endpoints of interactive server rendering and the static assets. The application is
// started on the in-memory test server (WebApplicationFactory, no socket), and its routes are read from the route table
// the routing middleware matches requests against: its EndpointDataSource. A pattern with optional parameters serves a
// path for each way of leaving them out; each path is confirmed by a request the framework dispatches to that endpoint.
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Oracle;

public static class RouteOracle
{
    const string RequestId = "x-route-oracle";
    static readonly string[] Samples = ["1", "a", "abc", "2020", "true", "00000000-0000-0000-0000-000000000001", "a/b", "a.txt", "a/b.txt"];
    static readonly string[] AnyMethod = ["GET", "POST", "PUT", "DELETE", "PATCH"];

    public static async Task<int> Main()
    {
        // WebApplicationFactory finds the application's content root in the manifest beside the oracle, from the working directory.
        Directory.SetCurrentDirectory(AppContext.BaseDirectory);
        var dispatched = new ConcurrentDictionary<string, Endpoint?>();
        await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(web =>
        {
            web.UseEnvironment("Production");
            // As published: served from a build's output, MapStaticAssets also reloads wwwroot at runtime, with a fallback
            // route for files added after the build.
            web.UseSetting("ReloadStaticAssetsAtRuntime", "false");
            web.ConfigureLogging(logging => logging.ClearProviders());
            web.ConfigureServices(services => services.AddSingleton<IStartupFilter>(new RecordEndpoint(dispatched)));
        });
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        var policies = factory.Services.GetRequiredService<ParameterPolicyFactory>();
        var table = factory.Services.GetRequiredService<EndpointDataSource>();

        var routes = new List<object>();
        var failures = new List<string>();
        foreach (var endpoint in table.Endpoints.OfType<RouteEndpoint>())
        {
            if (endpoint.Metadata.GetMetadata<ISuppressMatchingMetadata>()?.SuppressMatching == true) continue;
            var pattern = endpoint.RoutePattern;
            var methods = Methods(endpoint);
            foreach (var variant in Variants(pattern))
            {
                var path = "/" + string.Join("/", variant.Select(segment => string.Concat(segment.Select(part => Canonical(pattern, part))))).Trim('/');
                foreach (var method in methods)
                {
                    if (await Confirm(client, dispatched, policies, pattern, variant, method, endpoint))
                        routes.Add(new { method, path, raw = pattern.RawText });
                    else
                        failures.Add($"{method} {path} ({pattern.RawText}, {endpoint.DisplayName})");
                }
            }
        }
        if (failures.Count > 0)
        {
            Console.Error.WriteLine("no request dispatched to these routes of the table:\n  " + string.Join("\n  ", failures));
            return 1;
        }
        var version = typeof(Microsoft.AspNetCore.Components.ComponentBase).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion.Split('+')[0];
        Console.WriteLine(JsonSerializer.Serialize(new { framework = "blazor", version, routes }));
        return 0;
    }

    /// <summary>A parameter with a value the endpoint requires (a conventional route's controller and action) is that value.</summary>
    static string? Required(RoutePattern pattern, RoutePatternParameterPart parameter) =>
        pattern.RequiredValues.TryGetValue(parameter.Name, out var value) && value is not null && !ReferenceEquals(value, RoutePattern.RequiredValueAny)
            ? Convert.ToString(value)
            : null;

    static string Canonical(RoutePattern pattern, RoutePatternPart part) => part switch
    {
        RoutePatternLiteralPart literal => literal.Content,
        RoutePatternSeparatorPart separator => separator.Content,
        RoutePatternParameterPart parameter when Required(pattern, parameter) is { } value => value,
        RoutePatternParameterPart { IsCatchAll: true } => "{**}",
        _ => "{}",
    };

    /// <summary>
    /// The pattern's segments, then the pattern without each run of trailing segments that may be left out (an optional
    /// parameter, or one with a default the endpoint does not require otherwise), and without a trailing optional
    /// parameter of a segment (`{name}.{ext?}`) or a catch-all (`{*rest}`, which also takes nothing). Each is confirmed by a request before it is printed.
    /// </summary>
    static IEnumerable<List<List<RoutePatternPart>>> Variants(RoutePattern pattern)
    {
        var segments = pattern.PathSegments.Select(s => s.Parts.ToList()).ToList();
        yield return segments;
        var last = segments.Count > 0 ? segments[^1] : null;
        if (last is { Count: > 2 } && last[^1] is RoutePatternParameterPart { IsOptional: true } && last[^2] is RoutePatternSeparatorPart)
            yield return [.. segments.SkipLast(1), last.SkipLast(2).ToList()];
        var end = segments.Count;
        if (last is [RoutePatternParameterPart { IsCatchAll: true }])
        {
            // A catch-all takes none as well: the path that ends at its `/`, requested with that `/`.
            end--;
            yield return [.. segments.Take(end), []];
        }
        for (var k = end - 1; k >= 0; k--)
        {
            if (segments[k] is not [RoutePatternParameterPart { IsCatchAll: false } parameter] || !Omittable(pattern, parameter)) break;
            yield return segments.Take(k).ToList();
        }
    }

    static bool Omittable(RoutePattern pattern, RoutePatternParameterPart parameter)
    {
        if (parameter.IsOptional) return true;
        if (!pattern.Defaults.TryGetValue(parameter.Name, out var fallback)) return false;
        var required = Required(pattern, parameter);
        return required is null || string.Equals(required, Convert.ToString(fallback), StringComparison.OrdinalIgnoreCase);
    }

    static async Task<bool> Confirm(HttpClient client, ConcurrentDictionary<string, Endpoint?> dispatched, ParameterPolicyFactory policies,
        RoutePattern pattern, List<List<RoutePatternPart>> variant, string method, RouteEndpoint endpoint)
    {
        var parameters = variant.SelectMany(s => s).OfType<RoutePatternParameterPart>().Where(p => Required(pattern, p) is null).ToList();
        var choices = parameters.Select(p => Samples.Where(s => (p.IsCatchAll || !s.Contains('/')) && Accepts(policies, pattern, p, s)).ToList()).ToList();
        foreach (var values in Combinations(choices).Take(64))
        {
            var sample = parameters.Zip(values).ToDictionary(pv => pv.First, pv => pv.Second);
            var path = "/" + string.Join("/", variant.Select(segment => string.Concat(segment.Select(part => part switch
            {
                RoutePatternParameterPart parameter when sample.TryGetValue(parameter, out var value) => value,
                _ => Canonical(pattern, part),
            }))));
            foreach (var verb in method == "*" ? AnyMethod : [method])
            {
                var id = Guid.NewGuid().ToString();
                using var request = new HttpRequestMessage(new HttpMethod(verb), path);
                request.Headers.Add(RequestId, id);
                try { using var _ = await client.SendAsync(request); }
                catch (Exception) { /* the handler failed on the sample; the route was still dispatched */ }
                if (dispatched.TryRemove(id, out var hit) && Same(hit, endpoint)) return true;
            }
        }
        return false;
    }

    /// <summary>
    /// The route table is read through the EndpointDataSource service, whose data sources build their endpoints anew for
    /// each reader, so the endpoint a request is dispatched to is the same route, not the same object.
    /// </summary>
    static bool Same(Endpoint? hit, RouteEndpoint endpoint) =>
        hit is RouteEndpoint route
        && route.RoutePattern.RawText == endpoint.RoutePattern.RawText
        && route.Order == endpoint.Order
        && route.DisplayName == endpoint.DisplayName
        && Methods(route).SequenceEqual(Methods(endpoint));

    static string[] Methods(Endpoint endpoint) =>
        endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods is { Count: > 0 } m ? m.ToArray() : ["*"];

    static bool Accepts(ParameterPolicyFactory policies, RoutePattern pattern, RoutePatternParameterPart parameter, string value)
    {
        var references = pattern.ParameterPolicies.TryGetValue(parameter.Name, out var r) ? r : [];
        return references.All(reference => policies.Create(parameter, reference) is not IRouteConstraint constraint
            || constraint.Match(null, null, parameter.Name, new RouteValueDictionary { [parameter.Name] = value }, RouteDirection.IncomingRequest));
    }

    static IEnumerable<string[]> Combinations(List<List<string>> choices)
    {
        if (choices.Count == 0) { yield return []; yield break; }
        foreach (var head in choices[0])
            foreach (var tail in Combinations(choices.Skip(1).ToList()))
                yield return [head, .. tail];
    }

    /// <summary>
    /// Records, for each request the oracle sends, the endpoint the routing middleware chose for it: the first endpoint
    /// set, before an error page the application re-executes the request for (UseExceptionHandler, status code pages)
    /// replaces it.
    /// </summary>
    sealed class RecordEndpoint(ConcurrentDictionary<string, Endpoint?> dispatched) : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use(async (context, call) =>
            {
                var chosen = new FirstEndpoint();
                context.Features.Set<IEndpointFeature>(chosen);
                try { await call(context); }
                finally
                {
                    if (context.Request.Headers.TryGetValue(RequestId, out var id)) dispatched[id.ToString()] = chosen.First;
                }
            });
            next(app);
        };
    }

    sealed class FirstEndpoint : IEndpointFeature
    {
        Endpoint? endpoint;
        bool set;
        public Endpoint? First { get; private set; }
        public Endpoint? Endpoint
        {
            get => endpoint;
            set
            {
                endpoint = value;
                if (set) return;
                First = value;
                set = true;
            }
        }
    }
}
