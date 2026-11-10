from django.urls import include, path
from rest_framework.routers import DefaultRouter, SimpleRouter

from . import views

app_name = "api"

router = DefaultRouter()
router.register(r"items", views.ItemViewSet)
router.register(r"accounts", views.AccountViewSet, basename="account")

v2 = SimpleRouter(use_regex_path=False)
v2.register(r"notes", views.NoteViewSet, basename="note")

urlpatterns = [
    path("", include(router.urls)),
    path("v2/", include(v2.urls)),
    path("stats/", views.StatsView.as_view()),
    path("users/<int:pk>/", views.UserDetail.as_view()),
    path("ping/", views.ping),
    path("hello/", views.hello),
]
