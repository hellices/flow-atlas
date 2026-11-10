<?php

namespace App\Controller;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

final class HomeController
{
    public function home(Request $request, Response $response): Response
    {
        $response->getBody()->write('home');

        return $response;
    }

    public function contact(Request $request, Response $response): Response
    {
        $response->getBody()->write('contact');

        return $response;
    }
}
