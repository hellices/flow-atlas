import 'package:dio/dio.dart';

/// Requests to the billing service, on its own Dio (see `createBillingClient`).
class BillingRepository {
  BillingRepository(this._dio);

  final Dio _dio;

  Future<Map<String, dynamic>> invoice(int number) async {
    final response = await _dio.get<Map<String, dynamic>>('/invoices/$number');
    return response.data!;
  }

  Future<Map<String, dynamic>> pay(int number, String card) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/invoices/$number/payments',
      data: {'card': card},
    );
    return response.data!;
  }
}
