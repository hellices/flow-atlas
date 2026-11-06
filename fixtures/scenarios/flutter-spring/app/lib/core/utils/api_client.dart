import 'package:dio/dio.dart';

class ApiConstants {
  ApiConstants._();

  static const String baseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8080');
  static const String apiPrefix = '/api/v1';
}

Dio createApiClient() => Dio(BaseOptions(baseUrl: '${ApiConstants.baseUrl}${ApiConstants.apiPrefix}'));
