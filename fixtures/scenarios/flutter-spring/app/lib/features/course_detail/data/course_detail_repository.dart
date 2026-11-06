import 'package:dio/dio.dart';

class CourseDetailRepository {
  CourseDetailRepository(this._dio);

  final Dio _dio;

  Future<Map<String, dynamic>> detail(int id) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/courses/$id/detail',
    );
    return response.data!;
  }

  Future<List<dynamic>> related(int id) async {
    final response = await _dio.get<List<dynamic>>('/courses/$id/related');
    return response.data!;
  }
}
