<?php

/*
 * Asks Symfony which routes the application serves: `debug:router --format=json`, the route collection Symfony's router
 * matches with (attribute routes, YAML and PHP route files and their imports, and in the dev environment the error
 * pages FrameworkBundle serves). Each path written out is confirmed by the route's compiled regex (`pathRegex`, what
 * the URL matcher matches a request's path with) for a request on it.
 */

use App\Kernel;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Output\BufferedOutput;
use Symfony\Component\HttpKernel\Kernel as SymfonyKernel;

require __DIR__.'/vendor/autoload.php';

$env = getenv('APP_ENV') ?: 'dev';
$console = new Application(new Kernel($env, $env !== 'prod'));
$console->setAutoExit(false);
$output = new BufferedOutput();
if ($console->run(new ArrayInput(['command' => 'debug:router', '--format' => 'json']), $output) !== 0) {
    fwrite(STDERR, $output->fetch());
    exit(1);
}
$listed = json_decode($output->fetch(), true, flags: JSON_THROW_ON_ERROR);

/** Whether the whole of $value matches a requirement's regex. */
function takes(string $regex, string $value): bool
{
    return preg_match('#^(?:'.str_replace('#', '\#', $regex).')$#Du', $value) === 1;
}

/** A value one segment long the parameter takes: a sample, or a word from its requirement (`en|fr`). */
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
    throw new RuntimeException("no sample value for the requirement {$regex}");
}

/**
 * The paths a route serves in the canonical form. A parameter whose requirement takes a slash is the rest of the path
 * (`{**}`); a trailing parameter the route serves without (one with a default) gives the path without it, and without
 * the separator before it, as well. Each path is confirmed by the route's compiled regex.
 *
 * @return list<string>
 */
function paths(array $route): array
{
    $requirements = is_array($route['requirements']) ? $route['requirements'] : [];
    $rest = fn (string $name) => takes($requirements[$name] ?? '[^/]+', 'a/b');
    $param = '/\{!?(\w+)\}/';
    $canonical = fn (string $path) => preg_replace_callback($param, fn ($m) => $rest($m[1]) ? '{**}' : '{}', $path);
    $concrete = fn (string $path) => preg_replace_callback($param, fn ($m) => $rest($m[1]) ? 'a/b' : sample($requirements[$m[1]] ?? null), $path);
    $served = fn (string $path) => preg_match($route['pathRegex'], $path === '' ? '/' : $concrete($path)) === 1;

    $path = rtrim($route['path'], '/') ?: '/';
    if (! $served($path)) {
        throw new RuntimeException("route {$route['path']} does not take ".$concrete($path));
    }
    $out = [$canonical($path)];
    while (preg_match('/[\/,;.:\-_~+*=@|]?\{!?\w+\}$/', $path, $m)) {
        $path = substr($path, 0, -strlen($m[0]));
        if (! $served($path)) {
            break;
        }
        $out[] = $path === '' ? '/' : $canonical($path);
    }

    return $out;
}

$routes = [];
foreach ($listed as $name => $route) {
    // Hosts are not part of the form; this application has no host-bound route.
    if ($route['host'] !== 'ANY') {
        continue;
    }
    $methods = $route['method'] === 'ANY' ? ['*'] : explode('|', $route['method']);
    foreach ($methods as $method) {
        foreach (paths($route) as $path) {
            $routes[] = ['method' => $method, 'path' => $path, 'raw' => $route['path']];
        }
    }
}

echo json_encode(['framework' => 'symfony', 'version' => SymfonyKernel::VERSION, 'routes' => $routes], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
