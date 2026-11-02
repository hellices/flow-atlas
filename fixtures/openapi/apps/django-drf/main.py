import sys

import django
from django.conf import settings

settings.configure(
    DEBUG=True,
    SECRET_KEY="lab",
    ROOT_URLCONF=__name__,
    INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.auth", "rest_framework", "drf_spectacular"],
    REST_FRAMEWORK={"DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema"},
    SPECTACULAR_SETTINGS={"TITLE": "Orders", "VERSION": "1"},
)
django.setup()

from django.urls import include, path  # noqa: E402
from rest_framework import routers, viewsets  # noqa: E402
from rest_framework.decorators import action, api_view  # noqa: E402
from rest_framework.response import Response  # noqa: E402


class OrderViewSet(viewsets.ViewSet):
    def retrieve(self, request, pk=None):
        return Response({"id": pk})

    def create(self, request):
        return Response({})

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        return Response([])


@api_view(["GET"])
def health(request):
    return Response({})


router = routers.SimpleRouter()
router.register("orders", OrderViewSet, basename="order")
urlpatterns = [path("api/v1/", include(router.urls)), path("internal/health", health)]

if __name__ == "__main__":
    from django.core.management import call_command

    call_command("spectacular", "--format", "openapi-json", stdout=sys.stdout)
