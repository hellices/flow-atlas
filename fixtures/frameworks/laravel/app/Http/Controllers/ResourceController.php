<?php

namespace App\Http\Controllers;

/** The actions of a resource controller, each answering with its own name. */
abstract class ResourceController extends Controller
{
    public function index(): string
    {
        return static::class.'@index';
    }

    public function create(): string
    {
        return static::class.'@create';
    }

    public function store(): string
    {
        return static::class.'@store';
    }

    public function show(string ...$ids): string
    {
        return static::class.'@show '.implode(',', $ids);
    }

    public function edit(string ...$ids): string
    {
        return static::class.'@edit '.implode(',', $ids);
    }

    public function update(string ...$ids): string
    {
        return static::class.'@update '.implode(',', $ids);
    }

    public function destroy(string ...$ids): string
    {
        return static::class.'@destroy '.implode(',', $ids);
    }
}
