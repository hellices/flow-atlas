<?php

/*
 * Asks Laravel which routes the application serves: `route:list --json`, Laravel's own list of the routes its router
 * dispatches with (the application's route files, and the routes Laravel registers by itself: the health check, the
 * local disk's files). Each listed route is looked up in the router's route collection for its parameters'
 * constraints (`where`, global patterns), and each path written out is confirmed by the route's own matcher
 * (`Route::matches`, which Laravel dispatches with) for a request on it.
 */

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Http\Request;
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

/**
 * The paths a route serves in the canonical form, each with a request path the route's matcher accepts. A parameter
 * whose constraint takes a slash is the rest of the path (`{**}`); a trailing parameter the route serves without (an
 * optional one, `{name?}`, or a rest one that takes nothing) gives the path without it as well.
 *
 * @return list<string>
 */
function paths(Route $route, string $method): array
{
    $uri = '/'.ltrim($route->uri(), '/');
    $param = '/\{(\w+)\??\}/';
    $canonical = fn (string $path) => preg_replace_callback($param, fn ($m) => takes($route->wheres[$m[1]] ?? '[^/]+', 'a/b') ? '{**}' : '{}', $path);
    $concrete = fn (string $path) => preg_replace_callback($param, fn ($m) => takes($route->wheres[$m[1]] ?? '[^/]+', 'a/b') ? 'a/b' : sample($route->wheres[$m[1]] ?? null), $path);
    $served = fn (string $path) => $route->matches(Request::create($path === '' ? '/' : $concrete($path), $method === '*' ? 'GET' : $method));

    if (! $served($uri)) {
        throw new RuntimeException("route {$method} {$uri} does not take ".$concrete($uri));
    }
    $out = [$canonical($uri)];
    // The same path without its last parameter, and without the separator before it.
    for ($path = $uri; preg_match('/[\/.\-]?\{\w+\??\}$/', $path, $m); ) {
        $path = substr($path, 0, -strlen($m[0]));
        if (! $served($path)) {
            break;
        }
        $out[] = $path === '' ? '/' : $canonical($path);
    }

    return $out;
}

$routes = [];
foreach ($listed as $entry) {
    $route = $collection[($entry['domain'] ?? '').' '.$entry['method'].' '.$entry['uri']]
        ?? throw new RuntimeException("route:list lists {$entry['method']} {$entry['uri']}, which the router does not hold");
    if (($entry['domain'] ?? null) !== null) {
        continue;
    }
    $methods = explode('|', $entry['method']);
    // `Route::any` (and `Route::redirect`) registers every verb the router knows: a route for any method.
    if (array_diff(Router::$verbs, $methods) === [] && array_diff($methods, Router::$verbs) === []) {
        $methods = ['*'];
    }
    foreach ($methods as $method) {
        foreach (paths($route, $method) as $path) {
            $routes[] = ['method' => $method, 'path' => $path, 'raw' => $entry['uri']];
        }
    }
}

echo json_encode(['framework' => 'laravel', 'version' => $app->version(), 'routes' => $routes], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
