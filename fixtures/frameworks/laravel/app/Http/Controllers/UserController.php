<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class UserController extends Controller
{
    public function index(): string
    {
        return 'users';
    }

    public function store(Request $request): string
    {
        return 'stored';
    }
}
