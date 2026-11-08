<?php

/*
 * Asks Laravel which routes the application serves: `route:list --json`, Laravel's own list of the routes its router
 * dispatches with (the application's route files, and the routes Laravel registers by itself: the health check, the
 * local disk's files). Each listed route is looked up in the router's route collection for its parameters'
 * constraints (`where`, global patterns), and each path written out is confirmed by the route's own matcher
 * (`Route::matches`, which Laravel dispatches with) for a request on it.
 */

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Http\Request;
use Illuminate\Routing\Events\RouteMatched;
use Illuminate\Routing\Route;
use Illuminate\Routing\Router;

require __DIR__.'/vendor/autoload.php';

$app = require __DIR__.'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->call('route:list', ['--json' => true]);
$listed = json_decode($kernel->output(), true, flags: JSON_THROW_ON_ERROR);

$collection = [];
foreach ($app['router']->getRoutes()->getRoutes() as $route) {
    $collection[($route->getDomain() ?? '').' '.implode('|', $route->methods()).' '.$route->uri()] = $route;
}

/** Whether the whole of $value matches a constraint's regex. */
function takes(string $regex, string $value): bool
{
    return preg_match('#^(?:'.str_replace('#', '\#', $regex).')$#Du', $value) === 1;
}

/** A value one segment long the parameter takes: a sample, or a word from its constraint (`whereIn`). */
function sample(?string $regex): string
{
    if ($regex === null) {
        return 'x';
    }
    $words = array_filter(preg_split('/[^\w-]+/', $regex), fn ($w) => $w !== '');
    foreach (['1', 'x', 'a1', '2024', '123e4567-e89b-42d3-a456-426614174000', ...$words] as $candidate) {
        if (takes($regex, $candidate)) {
            return $candidate;
        }
    }
    throw new RuntimeException("no sample value for the constraint {$regex}");
}

/** A path of the route in the canonical form: a parameter whose constraint takes a slash is the rest of the path. */
function canonical(Route $route, string $path): string
{
    return preg_replace_callback('/\{(\w+)\??\}/', fn ($m) => takes($route->wheres[$m[1]] ?? '[^/]+', 'a/b') ? '{**}' : '{}', $path);
}

/** A path of the route with each parameter filled with a value it takes. */
function concrete(Route $route, string $path): string
{
    return $path === '' ? '/' : preg_replace_callback('/\{(\w+)\??\}/', fn ($m) => takes($route->wheres[$m[1]] ?? '[^/]+', 'a/b') ? 'a/b' : sample($route->wheres[$m[1]] ?? null), $path);
}

/**
 * The paths a route serves, each as [canonical form, a request path the route's matcher accepts]. A trailing parameter
 * the route serves without (an optional one, `{name?}`, or a rest one that takes nothing) gives the path without it as
 * well.
 *
 * @return list<array{string, string}>
 */
function forms(Route $route, string $method): array
{
    $uri = '/'.ltrim($route->uri(), '/');
    $served = fn (string $path) => $route->matches(Request::create(concrete($route, $path), $method === '*' ? 'GET' : $method));

    if (! $served($uri)) {
        throw new RuntimeException("route {$method} {$uri} does not take ".concrete($route, $uri));
    }
    $out = [[canonical($route, $uri), concrete($route, $uri)]];
    // The same path without its last parameter, and without the separator before it.
    for ($path = $uri; preg_match('/[\/.\-]?\{\w+\??\}$/', $path, $m); ) {
        $path = substr($path, 0, -strlen($m[0]));
        if (! $served($path)) {
            break;
        }
        $out[] = [$path === '' ? '/' : canonical($route, $path), concrete($route, $path)];
    }

    return $out;
}

/** The methods a route is listed under: `*` for one that takes every verb the router knows. */
function methodsOf(Route $route): array
{
    $methods = $route->methods();
    // `Route::any` (and `Route::redirect`) registers every verb the router knows: a route for any method.
    if (array_diff(Router::$verbs, $methods) === [] && array_diff($methods, Router::$verbs) === []) {
        return ['*'];
    }

    return $methods;
}

$routes = [];
$samples = [];
foreach ($listed as $entry) {
    $route = $collection[($entry['domain'] ?? '').' '.$entry['method'].' '.$entry['uri']]
        ?? throw new RuntimeException("route:list lists {$entry['method']} {$entry['uri']}, which the router does not hold");
    if (($entry['domain'] ?? null) !== null) {
        continue;
    }
    foreach (methodsOf($route) as $method) {
        foreach (forms($route, $method) as [$path, $request]) {
            $routes[] = ['method' => $method, 'path' => $path, 'raw' => $entry['uri']];
            $samples[] = $request;
        }
    }
}

/*
 * Sample requests, and the route Laravel dispatches each to: every route's sample path, also with a trailing `/`, and a
 * path no route takes, each with every method a route registers, HEAD and OPTIONS only where a route registers them on
 * their own (the compared form leaves out the HEAD beside a GET and the OPTIONS beside another method of the same
 * path), sent through the HTTP kernel. The route is the one the router reports matching (`RouteMatched`); its path is
 * the route's form without the trailing optional parameters the request left out. A request no route takes (404) or
 * that only routes for other methods take (405) is dispatched to none, and so is an OPTIONS request the router answers
 * itself, with a route it makes up to answer with the methods other routes of the path take (`getRouteForMethods`);
 * the fallback route takes what no other GET route does. A `Route::redirect` route answers with a redirect of its own,
 * but the request is dispatched to that route, so it is recorded as such. Laravel matches a request's path without its
 * trailing `/`, and redirects none.
 */
$keys = array_flip(array_map(fn ($r) => $r['method'].' '.$r['path'], $routes));
$methodsAt = [];
foreach ($routes as $r) {
    $methodsAt[$r['path']][$r['method']] = true;
}
$methods = array_values(array_unique(array_map(fn ($r) => $r['method'], array_filter(
    $routes,
    fn ($r) => $r['method'] !== '*'
        && ! ($r['method'] === 'HEAD' && isset($methodsAt[$r['path']]['GET']))
        && ! ($r['method'] === 'OPTIONS' && count($methodsAt[$r['path']]) > 1),
))));
sort($methods);
$samples = array_values(array_unique($samples));
$probes = array_unique([...$samples, ...array_map(fn ($s) => $s === '/' ? $s : $s.'/', $samples), '/nowhere/value1']);
sort($probes);

$http = $app->make(HttpKernel::class);
$held = $app['router']->getRoutes()->getRoutes();
$matched = null;
$app['events']->listen(RouteMatched::class, function (RouteMatched $event) use (&$matched) {
    $matched = [$event->route, $event->route->originalParameters()];
});
$requests = [];
foreach ($probes as $path) {
    foreach ($methods as $method) {
        $matched = null;
        $request = Request::create($path, $method);
        $response = $http->handle($request);
        $http->terminate($request, $response);
        if ($matched === null || ! in_array($matched[0], $held, true)) {
            $requests[] = ['method' => $method, 'path' => $path, 'route' => null];
            continue;
        }
        [$route, $parameters] = $matched;
        $uri = '/'.ltrim($route->uri(), '/');
        while (preg_match('/[\/.\-]?\{(\w+)\??\}$/', $uri, $m) && ! isset($parameters[$m[1]])) {
            $uri = substr($uri, 0, -strlen($m[0]));
        }
        $key = (methodsOf($route) === ['*'] ? '*' : $method).' '.($uri === '' ? '/' : canonical($route, $uri));
        if (! isset($keys[$key])) {
            throw new RuntimeException("{$method} {$path} is dispatched to {$key}, which is not a route listed");
        }
        $requests[] = ['method' => $method, 'path' => $path, 'route' => $key];
    }
}

echo json_encode(['framework' => 'laravel', 'version' => $app->version(), 'routes' => $routes, 'requests' => $requests], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
