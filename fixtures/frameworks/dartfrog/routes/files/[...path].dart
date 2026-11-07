import 'package:dart_frog/dart_frog.dart';

// A wildcard route: any path that starts with `/files/`, at any depth.
Response onRequest(RequestContext context, String path) {
  return Response(body: 'file: $path');
}
