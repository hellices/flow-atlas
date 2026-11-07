<?php

namespace App\Http\Controllers;

/** A single action controller. */
class ProvisionServer extends Controller
{
    public function __invoke(): string
    {
        return 'provisioned';
    }
}
