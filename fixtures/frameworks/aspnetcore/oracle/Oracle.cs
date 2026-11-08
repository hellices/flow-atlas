// Asks ASP.NET Core which routes the application serves. The application is started on the in-memory test server
// (WebApplicationFactory, no socket), and its routes are read from the route table the framework dispatches with: the
// EndpointDataSource the routing middleware matches requests against (minimal APIs, route groups, controllers,
// conventional routes, static assets). A pattern with optional parameters or default values serves a path for each
// way of leaving them out; each path is confirmed by a request the framework dispatches to that endpoint. Last, sample
// requests are sent, each recorded with the route of the endpoint the routing middleware chose for it.
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.Routing.Template;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Oracle;

public static class RouteOracle
{
    const string RequestId = "x-route-oracle";
    static readonly string[] Samples = ["1", "a", "abc", "2020", "00000000-0000-0000-0000-000000000001", "a/b", "a.txt", "a/b.txt"];
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
        var read = new List<(RouteEndpoint Endpoint, List<List<RoutePatternPart>> Variant, string Method, string Path)>();
        var samples = new SortedSet<string>(StringComparer.Ordinal) { "/nowhere/value1" };
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
                    if (await Confirm(client, dispatched, policies, pattern, variant, method, endpoint) is { } sample)
                    {
                        routes.Add(new { method, path, raw = pattern.RawText });
                        read.Add((endpoint, variant, method, path));
                        var trimmed = sample.TrimEnd('/');
                        samples.Add(trimmed == "" ? "/" : trimmed);
                        if (trimmed != "") samples.Add(trimmed + "/");
                    }
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
        // Sample requests: every route's sample path, also with a trailing `/`, and a path no route takes, each with every
        // method a route registers, HEAD and OPTIONS only where a route registers them on their own (the compared form
        // leaves out the HEAD beside a GET and the OPTIONS beside another method of the same path). The route is that of
        // the endpoint the routing middleware chose (`GetEndpoint()`); none, or an endpoint of no route in the table (the
        // 405 endpoint routing answers a method no endpoint of the path takes), is no route.
        var methodsAt = read.GroupBy(r => r.Path).ToDictionary(g => g.Key, g => g.Select(r => r.Method).ToHashSet());
        var verbs = read
            .Where(r => r.Method != "*" && !(r.Method == "HEAD" && methodsAt[r.Path].Contains("GET")) && !(r.Method == "OPTIONS" && methodsAt[r.Path].Count > 1))
            .Select(r => r.Method).Distinct().Order(StringComparer.Ordinal).ToList();
        var requests = new List<object>();
        foreach (var path in samples)
        {
            foreach (var method in verbs)
            {
                var hit = await Dispatch(client, dispatched, method, path);
                var candidates = hit is RouteEndpoint endpoint ? read.Where(r => Same(endpoint, r.Endpoint)).ToList() : [];
                if (candidates.Count == 0)
                {
                    requests.Add(new { method, path, route = (string?)null });
                    continue;
                }
                // The endpoint's pattern stands for a path for each way of leaving its optional parts out: the request's is
                // the first (fullest) whose template matches it with a value for each parameter it keeps.
                var variant = candidates.Select(r => r.Variant).Distinct().FirstOrDefault(v => Matches(candidates[0].Endpoint.RoutePattern, v, path))
                    ?? throw new InvalidOperationException($"{method} {path} is dispatched to {hit!.DisplayName}, none of whose paths matches it");
                var route = candidates.First(r => r.Variant == variant);
                requests.Add(new { method, path, route = $"{(route.Method == "*" ? "*" : method)} {route.Path}" });
            }
        }
        var version = typeof(WebApplication).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion.Split('+')[0];
        Console.WriteLine(JsonSerializer.Serialize(new { framework = "aspnetcore", version, routes, requests }));
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

    static async Task<Endpoint?> Dispatch(HttpClient client, ConcurrentDictionary<string, Endpoint?> dispatched, string method, string path)
    {
        var id = Guid.NewGuid().ToString();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        request.Headers.Add(RequestId, id);
        try { using var _ = await client.SendAsync(request); }
        catch (Exception) { /* the handler failed on the sample; the route was still dispatched */ }
        return dispatched.TryRemove(id, out var hit) ? hit : null;
    }

    /// <summary>Whether the variant's template (its parameters without constraints or defaults) matches the path, a value for each.</summary>
    static bool Matches(RoutePattern pattern, List<List<RoutePatternPart>> variant, string path)
    {
        var text = string.Join("/", variant.Select(segment => string.Concat(segment.Select(part => part switch
        {
            RoutePatternParameterPart parameter when Required(pattern, parameter) is { } value => value,
            RoutePatternParameterPart { IsCatchAll: true } parameter => $"{{*{parameter.Name}}}",
            RoutePatternParameterPart parameter => $"{{{parameter.Name}}}",
            RoutePatternLiteralPart literal => literal.Content.Replace("{", "{{").Replace("}", "}}"),
            RoutePatternSeparatorPart separator => separator.Content,
            _ => throw new InvalidOperationException($"no template for {part}"),
        })))).TrimEnd('/');
        var template = TemplateParser.Parse(text);
        var values = new RouteValueDictionary();
        return new TemplateMatcher(template, new RouteValueDictionary()).TryMatch(path, values)
            && template.Parameters.All(p => values.TryGetValue(p.Name!, out var v) && !string.IsNullOrEmpty(Convert.ToString(v)));
    }

    static async Task<string?> Confirm(HttpClient client, ConcurrentDictionary<string, Endpoint?> dispatched, ParameterPolicyFactory policies,
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
                if (dispatched.TryRemove(id, out var hit) && Same(hit, endpoint)) return path;
            }
        }
        return null;
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

    /// <summary>Records, for each request the oracle sends, the endpoint the routing middleware chose for it.</summary>
    sealed class RecordEndpoint(ConcurrentDictionary<string, Endpoint?> dispatched) : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use(async (context, call) =>
            {
                try { await call(context); }
                finally
                {
                    if (context.Request.Headers.TryGetValue(RequestId, out var id)) dispatched[id.ToString()] = context.GetEndpoint();
                }
            });
            next(app);
        };
    }
}
