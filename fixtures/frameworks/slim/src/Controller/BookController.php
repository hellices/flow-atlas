<?php

namespace App\Controller;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

final class BookController
{
    public function index(Request $request, Response $response): Response
    {
        return $this->text($response, 'books');
    }

    public function create(Request $request, Response $response): Response
    {
        return $this->text($response, 'created')->withStatus(201);
    }

    public function show(Request $request, Response $response, array $args): Response
    {
        return $this->text($response, 'book '.$args['id']);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        return $this->text($response, 'updated '.$args['id']);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $response->withStatus(204);
    }

    public function options(Request $request, Response $response): Response
    {
        return $response->withHeader('Allow', 'GET, PUT, PATCH, DELETE, OPTIONS');
    }

    private function text(Response $response, string $body): Response
    {
        $response->getBody()->write($body);

        return $response;
    }
}
