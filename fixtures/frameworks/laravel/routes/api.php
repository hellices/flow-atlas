<?php

use App\Http\Controllers\Api;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::get('/user', function (Request $request) {
    return ['user' => null];
});

Route::apiResource('photos', Api\PhotoController::class);

Route::prefix('v1')->name('v1.')->group(function () {
    Route::apiResources([
        'posts' => Api\PostController::class,
        'tags' => Api\TagController::class,
    ]);
});

Route::prefix('v2')->name('v2.')->group(function () {
    Route::apiResource('posts', Api\V2\PostController::class)->except(['destroy']);
});
