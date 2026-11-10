<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

// The class's route prefixes the path and the name of each of its methods' routes.
#[Route('/blog', name: 'blog_')]
final class BlogController
{
    #[Route('', name: 'index', methods: ['GET'])]
    public function index(): Response
    {
        return new Response('blog');
    }

    // A default makes the parameter optional: `/blog/page` serves page 1.
    #[Route('/page/{page}', name: 'list', requirements: ['page' => '\d+'], defaults: ['page' => 1], methods: ['GET'])]
    public function list(int $page): Response
    {
        return new Response("page $page");
    }

    // The requirement and the default inline.
    #[Route('/archive/{year<\d{4}>?2024}', name: 'archive', methods: ['GET'])]
    public function archive(int $year): Response
    {
        return new Response("archive $year");
    }

    #[Route('', name: 'create', methods: ['POST'])]
    public function create(): Response
    {
        return new Response('created', 201);
    }

    #[Route('/{slug}', name: 'show', methods: ['GET', 'HEAD'])]
    public function show(string $slug): Response
    {
        return new Response($slug);
    }

    #[Route('/{slug}', name: 'update', methods: ['PUT', 'PATCH'])]
    public function update(string $slug): Response
    {
        return new Response($slug);
    }

    #[Route('/{slug}', name: 'delete', methods: ['DELETE'])]
    public function delete(string $slug): Response
    {
        return new Response('', 204);
    }

    // Several routes on one method.
    #[Route('/{slug}/comments', name: 'comments', methods: ['GET'])]
    #[Route('/{slug}/comments/{id<\d+>}', name: 'comment', methods: ['GET'])]
    public function comments(string $slug, ?int $id = null): Response
    {
        return new Response("$slug $id");
    }
}
