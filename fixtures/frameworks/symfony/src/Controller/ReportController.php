<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

// An invokable controller: the class's route is the route.
#[Route('/report', name: 'report', methods: ['GET'])]
final class ReportController
{
    public function __invoke(): Response
    {
        return new Response('report');
    }
}
