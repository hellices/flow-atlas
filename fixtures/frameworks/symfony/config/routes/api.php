<?php

use App\Api\StatusController;
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return function (RoutingConfigurator $routes): void {
    $routes->import('../../src/Api/', 'attribute')
        ->prefix('/api/v1')
        ->namePrefix('api_v1_');

    $routes->add('api_status', '/api/status')
        ->controller([StatusController::class, 'status'])
        ->methods(['GET']);
};
