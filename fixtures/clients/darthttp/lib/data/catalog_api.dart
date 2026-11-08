import 'package:http/http.dart' as http;

/// The catalog service, through a `Client` instance as the README recommends for testability, wrapped in a
/// `BaseClient` subclass that adds the app's user agent; each URL built with `Uri.http` from the service's host and a
/// path, the query as its third argument.
class CatalogApi {
  CatalogApi(this.authority, {http.Client? client}) : _client = client ?? UserAgentClient('app/1.0', http.Client());

  final String authority;
  final http.Client _client;

  Future<String> listItems(String category, int page) async {
    final response = await _client.get(Uri.http(authority, '/catalog/items', {'category': category, 'page': '$page'}));
    return response.body;
  }

  Future<String> item(int id) async {
    final response = await _client.get(Uri.http(authority, '/catalog/items/$id'));
    return response.body;
  }

  Future<String> updateStock(int id, int count) async {
    final response = await _client.patch(Uri.http(authority, '/catalog/items/$id'), body: {'stock': '$count'});
    return response.body;
  }

  Future<String> addReview(int id, String text) async {
    final response = await _client.post(Uri.http(authority, 'catalog/items/$id/reviews'), body: {'text': text});
    return response.body;
  }

  Future<void> removeReview(int id, String reviewId) async {
    await _client.delete(Uri.http(authority, '/catalog/items/$id/reviews/$reviewId'));
  }
}

class UserAgentClient extends http.BaseClient {
  UserAgentClient(this.userAgent, this._inner);

  final String userAgent;
  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    request.headers['user-agent'] = userAgent;
    return _inner.send(request);
  }
}
