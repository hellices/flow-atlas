import 'dart:io';

import 'package:dart_frog/dart_frog.dart';

// A dynamic route: `routes/posts/[id].dart` is `/posts/1`, `/posts/2`, ...
Response onRequest(RequestContext context, String id) {
  return switch (context.request.method) {
    HttpMethod.get => Response(body: 'post id: $id'),
    HttpMethod.put => Response(body: 'updated $id'),
    HttpMethod.delete => Response(statusCode: HttpStatus.noContent),
    _ => Response(statusCode: HttpStatus.methodNotAllowed),
  };
}
