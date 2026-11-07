<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;

class UserController extends Controller
{
    public function index(): string
    {
        return 'admin users';
    }

    public function show(string $user): string
    {
        return 'admin user '.$user;
    }
}
