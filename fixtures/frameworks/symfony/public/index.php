<?php

use App\Kernel;
use Symfony\Component\HttpFoundation\Request;

require dirname(__DIR__).'/vendor/autoload.php';

$env = getenv('APP_ENV') ?: 'prod';
$kernel = new Kernel($env, (bool) (getenv('APP_DEBUG') ?: $env !== 'prod'));
$request = Request::createFromGlobals();
$response = $kernel->handle($request);
$response->send();
$kernel->terminate($request, $response);
