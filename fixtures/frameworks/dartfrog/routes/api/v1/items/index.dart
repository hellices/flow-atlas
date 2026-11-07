import 'dart:io';

import 'package:dart_frog/dart_frog.dart';

Response onRequest(RequestContext context) {
  return switch (context.request.method) {
    HttpMethod.get || HttpMethod.post => Response.json(body: <Object>[]),
    _ => Response(statusCode: HttpStatus.methodNotAllowed),
  };
}
