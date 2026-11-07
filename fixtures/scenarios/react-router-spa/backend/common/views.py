from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView


class StatusView(APIView):
    @extend_schema(summary="Check the API")
    def get(self, request):
        return Response({"message": "ok"}, status=status.HTTP_200_OK)
