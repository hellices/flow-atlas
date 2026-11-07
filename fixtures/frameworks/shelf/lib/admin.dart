import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

import 'app.dart';

/// Mounted under `/admin`, without a trailing slash: its `/` is `/admin` itself.
Router adminRouter(NewRouter newRouter) {
  return newRouter()
    ..get('/', (Request request) => Response.ok('admin'))
    ..get('/stats', (Request request) => Response.ok('{}'))
    ..delete('/cache', (Request request) => Response(204));
}
