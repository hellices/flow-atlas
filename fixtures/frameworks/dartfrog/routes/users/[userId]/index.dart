import 'dart:io';

import 'package:dart_frog/dart_frog.dart';

Response onRequest(RequestContext context, String userId) {
  if (context.request.method != HttpMethod.get) {
    return Response(statusCode: HttpStatus.methodNotAllowed);
  }
  return Response(body: 'user id: $userId');
}
