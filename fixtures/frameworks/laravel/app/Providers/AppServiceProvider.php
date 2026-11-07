<?php

namespace App\Providers;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // A global constraint: every `{team}` parameter is a number.
        Route::pattern('team', '[0-9]+');
    }
}
