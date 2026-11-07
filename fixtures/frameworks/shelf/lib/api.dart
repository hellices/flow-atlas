import 'dart:convert';

import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

import 'app.dart';

/// A service class whose router is mounted under `/api/`, as in shelf_router's example.
class Api {
  Api(this.newRouter);

  final NewRouter newRouter;

  Router get router {
    final router = newRouter();
    router.get('/messages', (Request request) => Response.ok(jsonEncode(<String>[])));
    router.get('/messages/<id|[0-9]+>', (Request request, String id) => Response.ok(jsonEncode({'id': id})));
    router.post('/messages', (Request request) => Response(201));
    return router;
  }
}
