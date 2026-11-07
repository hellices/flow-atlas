from django.http import HttpResponse
from django.views.decorators.http import require_GET, require_POST, require_safe


@require_safe
def history(request, page_slug, page_id):
    return HttpResponse(f"history of {page_slug}-{page_id}")


def edit(request, page_slug, page_id):
    return HttpResponse(f"edit {page_slug}-{page_id}")


@require_GET
def discuss(request, page_slug, page_id):
    return HttpResponse(f"discuss {page_slug}-{page_id}")


@require_POST
def permissions(request, page_slug, page_id):
    return HttpResponse(f"permissions of {page_slug}-{page_id}")
