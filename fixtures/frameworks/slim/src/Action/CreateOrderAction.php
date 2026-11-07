<?php

namespace App\Action;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

final class CreateOrderAction
{
    public function __invoke(Request $request, Response $response): Response
    {
        $response->getBody()->write('order');

        return $response->withStatus(201);
    }
}
