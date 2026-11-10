<?php

// No database: sessions live for the request.
return [
    'driver' => env('SESSION_DRIVER', 'array'),
];
