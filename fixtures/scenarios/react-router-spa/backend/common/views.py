from drf_spectacular.utils import extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response


class StatusViewSet(viewsets.ViewSet):
    @extend_schema(summary="Check the API")
    @action(detail=False, methods=["get"], url_path="")
    def retrieve_status(self, request):
        return Response({"message": "ok"}, status=status.HTTP_200_OK)
