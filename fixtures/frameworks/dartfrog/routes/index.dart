import 'package:dart_frog/dart_frog.dart';

// `routes/index.dart` is `/`; one handler answers every method.
Response onRequest(RequestContext context) {
  return Response(body: 'This is a ${context.request.method.value} request.');
}
