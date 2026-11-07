# The routes of Django's URL dispatcher guide (docs.djangoproject.com/en/stable/topics/http/urls/): path converters, a
# custom converter, regular expressions with a nested optional group, included URLconfs with namespaces, an included
# list with captured parameters, extra options, class-based views, the admin, Django REST framework's routers and
# views, and the media files Django serves while DEBUG is on.
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.generic import RedirectView, TemplateView

from . import views

urlpatterns = [
    path("", TemplateView.as_view(template_name="home.html"), name="home"),
    path("about/", TemplateView.as_view(template_name="about.html"), name="about"),
    path("about-us/", RedirectView.as_view(pattern_name="about", permanent=True)),
    path("admin/", admin.site.urls),
    path("blog/", include("blog.urls")),
    path("author-blog/", include("blog.urls", namespace="author-blog")),
    path("api/", include("api.urls")),
    path("api-auth/", include("rest_framework.urls")),
    re_path(
        r"^wiki/(?P<page_slug>[\w-]+)-(?P<page_id>\w+)/",
        include(
            [
                path("history/", views.history),
                path("edit/", views.edit),
                path("discuss/", views.discuss),
                path("permissions/", views.permissions),
            ]
        ),
    ),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
