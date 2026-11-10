# Django REST framework's views (www.django-rest-framework.org/api-guide/views/, /viewsets/, /routers/): a
# ModelViewSet with extra actions, a ViewSet, a ViewSet routed with path converters, an APIView and @api_view functions.
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Item
from .serializers import ItemSerializer


class ItemViewSet(viewsets.ModelViewSet):
    queryset = Item.objects.all()
    serializer_class = ItemSerializer

    @action(detail=True, methods=["post"], url_path="set-status")
    def set_status(self, request, pk=None, format=None):
        return Response({"status": "set"})

    @action(detail=False)
    def recent(self, request, format=None):
        return Response([])

    @action(detail=True, url_path=r"tags/(?P<tag>[^/.]+)")
    def tag(self, request, pk=None, tag=None, format=None):
        return Response({"tag": tag})

    @action(detail=False, methods=["get"])
    def archive(self, request, format=None):
        return Response([])

    @archive.mapping.delete
    def clear_archive(self, request, format=None):
        return Response(status=status.HTTP_204_NO_CONTENT)


class AccountViewSet(viewsets.ViewSet):
    lookup_value_regex = "[0-9]+"

    def list(self, request, format=None):
        return Response([])

    def create(self, request, format=None):
        return Response({}, status=status.HTTP_201_CREATED)

    def retrieve(self, request, pk=None, format=None):
        return Response({"id": pk})

    def partial_update(self, request, pk=None, format=None):
        return Response({"id": pk})


class NoteViewSet(viewsets.ViewSet):
    lookup_field = "note_id"
    lookup_value_converter = "uuid"

    def list(self, request):
        return Response([])

    def retrieve(self, request, note_id=None):
        return Response({"id": str(note_id)})

    def destroy(self, request, note_id=None):
        return Response(status=status.HTTP_204_NO_CONTENT)


class StatsView(APIView):
    def get(self, request):
        return Response({"items": 0})


class UserDetail(APIView):
    def get(self, request, pk):
        return Response({"id": pk})

    def put(self, request, pk):
        return Response({"id": pk})

    def delete(self, request, pk):
        return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET", "POST"])
def ping(request):
    return Response({"message": "pong"})


@api_view()
def hello(request):
    return Response({"message": "Hello, world!"})
