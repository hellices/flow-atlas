<?php

namespace App\Http\Controllers;

class OrderController extends Controller
{
    public function show(string $id): string
    {
        return 'order '.$id;
    }

    public function store(): string
    {
        return 'stored';
    }
}
