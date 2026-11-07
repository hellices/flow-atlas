<?php

/*
 * Asks Slim which routes the application serves: the routes its route collector holds
 * (`$app->getRouteCollector()->getRoutes()`, which Slim hands to FastRoute to dispatch with), each pattern split into
 * the paths it matches by FastRoute's own route parser (its optional segments), and each path confirmed by a request
 * the application handles and dispatches to that route.
 */

use Composer\InstalledVersions;
use FastRoute\RouteParser\Std;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

require __DIR__.'/vendor/autoload.php';

$app = require __DIR__.'/app/app.php';

// The methods `any` maps: a route on all of them takes any method Slim routes.
$any = AppFactory::create()->any('/', fn ($request, $response) => $response)->getMethods();
sort($any);

/** Whether the whole of $value matches a placeholder's expression. */
function takes(string $regex, string $value): bool
{
    return preg_match('~^(?:'.str_replace('~', '\~', $regex).')$~Du', $value) === 1;
}

/** A value one segment long the placeholder takes: a sample, or a word of its expression (`json|xml`). */
function sample(string $regex): string
{
    if (takes($regex, 'a/b')) {
        return 'a/b';
    }
    $words = array_filter(preg_split('/[^\w-]+/', $regex), fn ($w) => $w !== '');
    foreach (['1', 'x', 'a1', '2024', ...$words] as $candidate) {
        if (takes($regex, $candidate)) {
            return $candidate;
        }
    }
    throw new RuntimeException("no sample value for the expression {$regex}");
}

// Each request records the route Slim dispatched it to.
$dispatched = null;
foreach ($app->getRouteCollector()->getRoutes() as $route) {
    $route->add(function (ServerRequestInterface $request, RequestHandlerInterface $handler) use (&$dispatched, $route): ResponseInterface {
        $dispatched = $route->getIdentifier();

        return $handler->handle($request);
    });
}
$requests = new ServerRequestFactory();
$served = function (string $method, string $path, $route) use ($app, $requests, &$dispatched): bool {
    $dispatched = null;
    $app->handle($requests->createServerRequest($method, $path === '' ? '/' : $path));

    return $dispatched === $route->getIdentifier();
};

$parser = new Std();
$routes = [];
foreach ($app->getRouteCollector()->getRoutes() as $route) {
    $methods = $route->getMethods();
    sort($methods);
    $asked = $methods === $any ? ['*'] : $methods;
    foreach ($parser->parse($route->getPattern()) as $parts) {
        $canonical = '';
        $concrete = '';
        $last = null;
        foreach ($parts as $part) {
            if (is_string($part)) {
                $canonical .= $part;
                $concrete .= $part;
                $last = null;
            } else {
                $canonical .= takes($part[1], 'a/b') ? '{**}' : '{}';
                $concrete .= sample($part[1]);
                $last = $part[1];
            }
        }
        $paths = [$canonical];
        // A rest placeholder that takes nothing as well: the route serves the path it follows, with its `/`.
        $parent = null;
        if (str_ends_with($canonical, '/{**}') && takes($last, '')) {
            $parent = substr($concrete, 0, -strlen(sample($last)));
            $paths[] = substr($canonical, 0, -strlen('/{**}')) ?: '/';
        }
        foreach ($methods as $method) {
            if (! $served($method, $concrete, $route) || ($parent !== null && ! $served($method, $parent, $route))) {
                throw new RuntimeException("{$method} {$concrete} is not dispatched to the route ".$route->getPattern());
            }
        }
        foreach ($asked as $method) {
            foreach ($paths as $path) {
                $routes[] = ['method' => $method, 'path' => $path, 'raw' => $route->getPattern()];
            }
        }
    }
}

echo json_encode(['framework' => 'slim', 'version' => ltrim(InstalledVersions::getPrettyVersion('slim/slim'), 'v'), 'routes' => $routes], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
