from django.urls import path, re_path, register_converter

from . import converters, views

app_name = "blog"

register_converter(converters.FourDigitYearConverter, "yyyy")

urlpatterns = [
    path("articles/2003/", views.special_case_2003),
    path("articles/<yyyy:year>/", views.year_archive),
    path("articles/<int:year>/<int:month>/", views.month_archive),
    path("articles/<int:year>/<int:month>/<slug:slug>/", views.article_detail),
    re_path(r"^archive/(?P<year>[0-9]{4})/$", views.year_archive),
    re_path(r"^comments/(?:page-(?P<page_number>\d+)/)?$", views.comments),
    path("drafts/<uuid:draft_id>/", views.draft),
    path("files/<path:file_path>", views.download),
    path("tags/<str:tag>/", views.tag, {"feed": False}),
    path("tags/<str:tag>/feed/", views.tag, {"feed": True}),
    path("posts/", views.PostList.as_view(), name="post-list"),
    path("posts/<int:pk>/", views.PostDetail.as_view(), name="post-detail"),
]
