<?php

use Slim\App;
use Slim\Factory\AppFactory;

require __DIR__.'/../vendor/autoload.php';

/** @var App $app */
$app = AppFactory::create();

$app->addRoutingMiddleware();
$app->addErrorMiddleware(false, true, true);

(require __DIR__.'/routes.php')($app);

return $app;
