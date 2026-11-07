import 'package:dart_frog/dart_frog.dart';

// Nested dynamic routes: `/users/alice/posts/1`.
Response onRequest(RequestContext context, String userId, String postId) {
  return Response(body: 'user id: $userId, post id: $postId');
}
