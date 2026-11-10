import 'package:dio/dio.dart';

/// Requests for users and their orders, in the shapes dio's guide shows: a path relative to the base URL, a value in a
/// template or a concatenation, `data` for the body, `queryParameters`, a method in `Options`, per-request headers.
class UserRepository {
  UserRepository(this._dio);

  final Dio _dio;

  Future<Map<String, dynamic>> listUsers(int page) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/users',
      queryParameters: {'page': page, 'per_page': 20},
    );
    return response.data!;
  }

  Future<Map<String, dynamic>> getUser(String id) async {
    final response = await _dio.get<Map<String, dynamic>>('/users/$id');
    return response.data!;
  }

  Future<Map<String, dynamic>> createUser(String name) async {
    final response = await _dio.post<Map<String, dynamic>>('/users', data: {'name': name});
    return response.data!;
  }

  Future<void> replaceUser(String id, String name) async {
    await _dio.put<void>('/users/${id}', data: {'id': id, 'name': name});
  }

  Future<void> renameUser(String id, String name) async {
    await _dio.request<void>(
      '/users/$id',
      data: {'name': name},
      options: Options(method: 'PATCH'),
    );
  }

  Future<void> deleteUser(String id) async {
    await _dio.delete<void>('/users/$id', options: Options(headers: {'X-Confirm': 'yes'}));
  }

  Future<Map<String, dynamic>> orderItems(String orderId) async {
    final response = await _dio.get<Map<String, dynamic>>('/orders/' + orderId + '/items');
    return response.data!;
  }

  Future<Map<String, dynamic>> searchProducts(String term) async {
    final response = await _dio.query<Map<String, dynamic>>(
      '/products/search',
      data: {
        'filter': {'name': term},
      },
    );
    return response.data!;
  }
}
