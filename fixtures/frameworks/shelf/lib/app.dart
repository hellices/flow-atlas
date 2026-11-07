// Routes in the shapes shelf_router documents (pub.dev/packages/shelf_router, its example and the `Router` API docs):
// a route per verb, parameters with and without a regular expression, several in one segment, `all` for every method,
// `add` for a verb by name, a parameter whose regular expression takes the rest of the path, routers mounted under a
// prefix with and without its trailing slash, and the catch-all the example ends with.
import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

import 'admin.dart';
import 'api.dart';

/// Makes each router the application is built of: shelf_router's own constructor when served.
typedef NewRouter = Router Function();

Router buildRouter([NewRouter newRouter = Router.new]) {
  final router = newRouter();

  router.get('/', (Request request) => Response.ok('home'));
  router.get('/hello', (Request request) => Response.ok('hello-world'));

  router.get('/users/<userName>/whoami', (Request request) {
    return Response.ok('You are ${request.params['userName']}');
  });
  router.get('/users/<userName>/say-hello', (Request request, String userName) {
    return Response.ok('Hello $userName');
  });
  router.get(r'/users/<userName>/messages/<msgId|\d+>', (Request request, String userName, String msgId) {
    return Response.ok('message $msgId of $userName');
  });
  router.get('/flights/<from>-<to>', (Request request, String from, String to) => Response.ok('$from to $to'));

  router.get('/items', (Request request) => Response.ok('[]'));
  router.post('/items', (Request request) => Response(201));
  router.put('/items/<id|[0-9]+>', (Request request, String id) => Response.ok('updated $id'));
  router.delete('/items/<id|[0-9]+>', (Request request, String id) => Response(204));
  router.add('PATCH', '/items/<id|[0-9]+>', (Request request, String id) => Response.ok('patched $id'));

  router.all('/echo', (Request request) => Response.ok(request.method));
  router.get('/files/<path|.*>', (Request request, String path) => Response.ok('file $path'));

  router.mount('/api/', Api(newRouter).router.call);
  router.mount('/admin', adminRouter(newRouter).call);

  router.all('/<ignored|.*>', (Request request) => Response.notFound('Page not found'));
  return router;
}
