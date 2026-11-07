from django.http import HttpResponse
from django.views import View
from django.views.decorators.http import require_http_methods


def special_case_2003(request):
    return HttpResponse("2003")


def year_archive(request, year):
    return HttpResponse(f"archive {year}")


def month_archive(request, year, month):
    return HttpResponse(f"archive {year}-{month}")


def article_detail(request, year, month, slug):
    return HttpResponse(f"article {slug}")


def comments(request, page_number=None):
    return HttpResponse(f"comments page {page_number or 1}")


@require_http_methods(["GET", "POST"])
def draft(request, draft_id):
    return HttpResponse(f"draft {draft_id}")


def download(request, file_path):
    return HttpResponse(f"file {file_path}")


def tag(request, tag, feed):
    return HttpResponse(f"tag {tag}{' feed' if feed else ''}")


class PostList(View):
    def get(self, request):
        return HttpResponse("posts")

    def post(self, request):
        return HttpResponse("created", status=201)


class PostDetail(View):
    http_method_names = ["get", "put", "delete", "options"]

    def get(self, request, pk):
        return HttpResponse(f"post {pk}")

    def put(self, request, pk):
        return HttpResponse(f"updated {pk}")

    def patch(self, request, pk):
        return HttpResponse("never reached: PATCH is not in http_method_names")

    def delete(self, request, pk):
        return HttpResponse(status=204)
