# The NinjaAPI instances mounted in Django's URLconf (django-ninja.dev/guide/versioning/): each serves its operations,
# its OpenAPI document and its docs page under the prefix it is included at, beside the project's own views.
from django.urls import path

from . import views
from .api import api, api_v1, api_v2

urlpatterns = [
    path("", views.home),
    path("api/v1/", api_v1.urls),
    path("api/v2/", api_v2.urls),
    path("api/", api.urls),
]
