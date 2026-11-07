from django.contrib import admin
from django.urls import include, path

from common.views import RestViewSet
from drf_spectacular.views import SpectacularAPIView
from rest_framework.routers import DefaultRouter
from users.views import UserViewSet


router = DefaultRouter()
router.register(r"users", UserViewSet, basename="user")
router.register(r"rest", RestViewSet, basename="rest")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include(router.urls), name="api"),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
]
