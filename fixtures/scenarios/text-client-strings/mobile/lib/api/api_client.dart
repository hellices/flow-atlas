import 'package:dio/dio.dart';

class ApiClient {
  final Dio _dio;

  ApiClient(String endpoint) : _dio = Dio(BaseOptions(baseUrl: endpoint));

  Future<Response<dynamic>> get(String path) => _dio.get(path);
}
