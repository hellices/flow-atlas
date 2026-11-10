import 'package:dart_frog/dart_frog.dart';

// Nested directories make nested paths: `/api/v1/status`.
Response onRequest(RequestContext context) {
  return Response.json(body: {'status': 'ok'});
}
