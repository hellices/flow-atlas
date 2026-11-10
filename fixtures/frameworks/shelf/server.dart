import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;

import 'package:shelf_fixture/app.dart';

Future<void> main() async {
  final handler = const Pipeline().addMiddleware(logRequests()).addHandler(buildRouter().call);
  final server = await io.serve(handler, 'localhost', 8080);
  print('Serving at http://${server.address.host}:${server.port}');
}
