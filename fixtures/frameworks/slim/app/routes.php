<?php

use App\Action\CreateOrderAction;
use App\Controller\BookController;
use App\Controller\HomeController;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

return function (App $app): void {
    $text = function (string $body): callable {
        return function (Request $request, Response $response, array $args) use ($body): Response {
            $response->getBody()->write($body.' '.implode(' ', $args));

            return $response;
        };
    };

    // Controllers, by `Class:method`, by `[Class, method]`, and an invokable action.
    $app->get('/', HomeController::class.':home');
    $app->get('/contact', [HomeController::class, 'contact']);
    $app->post('/orders', CreateOrderAction::class);

    // One route a method, several methods on one path.
    $app->get('/books', BookController::class.':index');
    $app->post('/books', BookController::class.':create');
    $app->get('/books/{id}', BookController::class.':show');
    $app->put('/books/{id}', BookController::class.':update');
    $app->patch('/books/{id}', BookController::class.':update');
    $app->delete('/books/{id}', BookController::class.':delete');
    $app->options('/books/{id}', BookController::class.':options');

    // One route for several methods, and for any.
    $app->map(['GET', 'POST'], '/forms', $text('form'));
    $app->any('/items[/{id}]', $text('item'));

    $app->redirect('/library', '/books', 301);

    // Placeholders, optional segments and regular expressions.
    $app->get('/hello/{name}', $text('hello'));
    $app->get('/accounts[/{id}]', $text('account'));
    $app->get('/news[/{year}[/{month}]]', $text('news'));
    $app->get('/archive[/{params:.*}]', $text('archive'));
    $app->get('/members/{id:[0-9]+}', $text('member'));
    $app->get('/posts/{slug:[a-z0-9-]+}.{format:json|xml}', $text('post'));
    $app->get('/flights/{from}-{to}', $text('flight'));
    // A placeholder whose expression takes slashes: the rest of the path.
    $app->get('/files/{path:.+}', $text('file'));

    // Groups, a placeholder in the group's pattern, an empty pattern, and nested groups.
    $app->group('/users/{id:[0-9]+}', function (RouteCollectorProxy $group) use ($text) {
        $group->map(['GET', 'DELETE', 'PATCH', 'PUT'], '', $text('user'))->setName('user');
        $group->get('/reset-password', $text('reset'))->setName('user-password-reset');
    });

    $app->group('', function (RouteCollectorProxy $group) use ($text) {
        $group->get('/billing', $text('billing'));
        $group->get('/invoice/{id:[0-9]+}', $text('invoice'));
    });

    $app->group('/api', function (RouteCollectorProxy $api) use ($text) {
        $api->get('/status', $text('status'));
        $api->group('/v1', function (RouteCollectorProxy $v1) use ($text) {
            $v1->get('/tags', $text('tags'));
            $v1->post('/tags', $text('tag'));
            $v1->get('/tags/{tag}', $text('tag'));
        });
    });

    // The CORS cookbook's catch-all preflight route.
    $app->options('/{routes:.+}', function (Request $request, Response $response): Response {
        return $response;
    });
};
