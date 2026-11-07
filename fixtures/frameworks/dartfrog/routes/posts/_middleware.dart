import 'package:dart_frog/dart_frog.dart';

// Middleware for the routes under `routes/posts`.
Handler middleware(Handler handler) {
  return handler.use(provider<String>((context) => 'posts'));
}
