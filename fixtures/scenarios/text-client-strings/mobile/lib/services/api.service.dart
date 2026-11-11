import '../api/api_client.dart';

class ApiService {
  final ApiClient _api;

  ApiService(this._api);

  Future<String> resolveEndpoint(String serverUrl) async {
    if (serverUrl.endsWith('/api')) {
      return serverUrl;
    }
    final res = await _api.get('/server/ping');
    return res.statusCode == 200 ? serverUrl : '';
  }
}
