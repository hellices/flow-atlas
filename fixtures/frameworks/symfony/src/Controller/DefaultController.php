<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Routing\Requirement\Requirement;

final class DefaultController
{
    // No `methods`: the route takes any method.
    #[Route('/', name: 'home')]
    public function home(): Response
    {
        return new Response('home');
    }

    #[Route('/contact', name: 'contact', methods: ['GET', 'POST'])]
    public function contact(): Response
    {
        return new Response('contact');
    }

    // A localized route: one path per locale.
    #[Route(path: ['en' => '/about-us', 'nl' => '/over-ons'], name: 'about')]
    public function about(): Response
    {
        return new Response('about');
    }

    #[Route('/user/{id}', name: 'user_show', requirements: ['id' => Requirement::DIGITS], methods: ['GET'])]
    public function user(int $id): Response
    {
        return new Response("user $id");
    }

    #[Route('/flights/{from}-{to}', name: 'flights')]
    public function flights(string $from, string $to): Response
    {
        return new Response("$from-$to");
    }

    // A parameter whose requirement takes slashes: the rest of the path.
    #[Route('/share/{token}', name: 'share', requirements: ['token' => '.+'])]
    public function share(string $token): Response
    {
        return new Response($token);
    }

    #[Route('/files/{path}', name: 'files', requirements: ['path' => Requirement::CATCH_ALL], methods: ['GET'])]
    public function files(string $path): Response
    {
        return new Response($path);
    }

    #[Route('/{_locale}/search.{_format}', name: 'search', requirements: ['_locale' => 'en|fr', '_format' => 'html|xml'], defaults: ['_format' => 'html'])]
    public function search(): Response
    {
        return new Response('search');
    }
}
