<?php

namespace App\Api;

use Symfony\Component\HttpFoundation\JsonResponse;

// Routed from config/routes/api.php, not by an attribute.
final class StatusController
{
    public function status(): JsonResponse
    {
        return new JsonResponse(['status' => 'ok']);
    }
}
