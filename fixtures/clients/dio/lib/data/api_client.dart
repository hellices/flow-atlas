import 'package:dio/dio.dart';

/// The app's one Dio for its API, as dio's guide recommends: a singleton with the base URL, timeouts and headers in
/// `BaseOptions`, and an interceptor that adds the session's token to every request.
Dio createApiClient(String host, {String token = ''}) {
  final dio = Dio(
    BaseOptions(
      baseUrl: '$host/api/v1',
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 3),
      headers: {'Accept': 'application/json'},
    ),
  );
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) {
        options.headers['Authorization'] = 'Bearer $token';
        return handler.next(options);
      },
    ),
  );
  return dio;
}

/// The billing service lives under its own base path, and versions its API in the path: an interceptor puts the
/// version before each path the app requests.
class ApiVersionInterceptor extends Interceptor {
  ApiVersionInterceptor(this.version);

  final String version;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.path = '/$version${options.path}';
    super.onRequest(options, handler);
  }
}

Dio createBillingClient(String host) {
  final dio = Dio();
  dio.options.baseUrl = '$host/billing';
  dio.options.connectTimeout = const Duration(seconds: 5);
  dio.interceptors.add(ApiVersionInterceptor('v2'));
  return dio;
}
