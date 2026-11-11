import '../api/api_client.dart';
import '../models/user.dart';

class UserRepository {
  final ApiClient _api;

  UserRepository(this._api);

  Future<User> me() async {
    final res = await _api.get('/users/me');
    return User.fromJson(res.data as Map<String, dynamic>);
  }
}
