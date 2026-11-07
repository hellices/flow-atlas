import 'dart:io';

import 'package:dart_frog/dart_frog.dart';

// The handler decides which methods it answers.
Future<Response> onRequest(RequestContext context) async {
  return switch (context.request.method) {
    HttpMethod.get => Response.json(body: <Object>[]),
    HttpMethod.post => Response(statusCode: HttpStatus.created, body: await context.request.body()),
    _ => Response(statusCode: HttpStatus.methodNotAllowed),
  };
}
