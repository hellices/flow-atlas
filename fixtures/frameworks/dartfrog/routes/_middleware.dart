import 'package:dart_frog/dart_frog.dart';

// Middleware for every request (dart-frog.dev/basics/middleware).
Handler middleware(Handler handler) {
  return handler.use(requestLogger());
}
