from drf_spectacular.utils import OpenApiExample, extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


class RestViewSet(viewsets.ViewSet):
    serializer_class = None

    @extend_schema(
        summary="Check REST API",
        examples=[OpenApiExample("Successful Response", value={"message": "This message comes from the backend."})],
    )
    @action(
        detail=False,
        methods=["get"],
        permission_classes=[AllowAny],
        url_path="rest-check",
    )
    def rest_check(self, request):
        return Response({"result": "This message comes from the backend."}, status=status.HTTP_200_OK)
