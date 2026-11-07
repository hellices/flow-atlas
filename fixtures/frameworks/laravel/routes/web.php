<?php

use App\Http\Controllers\Admin;
use App\Http\Controllers\OrderController;
use App\Http\Controllers\PhotoCommentController;
use App\Http\Controllers\PhotoController;
use App\Http\Controllers\ProfileController;
use App\Http\Controllers\ProvisionServer;
use App\Http\Controllers\UserController;
use App\Http\Controllers\VideoController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return 'Hello World';
});

Route::get('/greeting', function () {
    return 'Hello World';
});

// Several methods on one path, and one route for several methods or for any.
Route::get('/user', [UserController::class, 'index']);
Route::post('/user', [UserController::class, 'store']);
Route::match(['get', 'post'], '/contact', function () {
    return 'contact';
});
Route::any('/ping', function () {
    return 'pong';
});
Route::put('/settings', function () {
    return 'saved';
});
Route::patch('/settings', function () {
    return 'patched';
});
Route::delete('/settings', function () {
    return 'reset';
});
Route::options('/capabilities', function () {
    return 'capabilities';
});

Route::post('/server', ProvisionServer::class);

Route::redirect('/here', '/there');
Route::permanentRedirect('/old-home', '/');
Route::view('/welcome', 'welcome', ['name' => 'Taylor']);

// Parameters, optional parameters and constraints.
Route::get('/user/{id}', function (string $id) {
    return 'User '.$id;
})->where('id', '[0-9]+');
Route::get('/user/{id}/{name}', function (string $id, string $name) {
    return $id.' '.$name;
})->where(['id' => '[0-9]+', 'name' => '[a-z]+']);
Route::get('/user/profile', function () {
    return 'profile';
})->name('profile');
Route::get('/posts/{post}/comments/{comment}', function (string $postId, string $commentId) {
    return $postId.' '.$commentId;
});
Route::get('/member/{name?}', function (?string $name = 'John') {
    return $name;
});
Route::get('/category/{category}', function (string $category) {
    return $category;
})->whereIn('category', ['movie', 'song', 'painting']);
Route::get('/teams/{team}', function (string $team) {
    return $team;
});
Route::get('/flights/{from}-{to}', function (string $from, string $to) {
    return $from.'-'.$to;
});
// A parameter that takes the rest of the path, slashes included.
Route::get('/search/{search}', function (string $search) {
    return $search;
})->where('search', '.*');

// Groups: prefixes, name prefixes, nested groups, controller groups.
Route::prefix('admin')->name('admin.')->group(function () {
    Route::get('/users', [Admin\UserController::class, 'index'])->name('users');
    Route::get('/users/{user}', [Admin\UserController::class, 'show'])->whereNumber('user')->name('users.show');

    Route::prefix('reports')->name('reports.')->group(function () {
        Route::get('/', function () {
            return 'reports';
        })->name('index');
        Route::get('/{year}/{month?}', function (string $year, ?string $month = null) {
            return $year.' '.$month;
        })->whereNumber(['year', 'month'])->name('show');
    });
});

Route::controller(OrderController::class)->group(function () {
    Route::get('/orders/{id}', 'show');
    Route::post('/orders', 'store');
});

// Resource controllers.
Route::resource('photos', PhotoController::class);
Route::resource('photos.comments', PhotoCommentController::class)->shallow();
Route::resource('videos', VideoController::class)->only(['index', 'show']);
Route::singleton('profile', ProfileController::class);

Route::fallback(function () {
    return 'Not here';
});
