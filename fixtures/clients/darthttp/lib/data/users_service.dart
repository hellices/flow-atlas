import 'dart:convert';

import 'package:http/http.dart' as http;

/// Users, with the package's top-level functions, as its README shows them: a URL parsed from the API's base URL and a
/// path with the value in it, a body and headers, a `Request` sent through a `Client` for a method it builds itself.
class UsersService {
  UsersService(String origin) : baseUrl = '$origin/api';

  final String baseUrl;

  Future<Map<String, dynamic>> getUser(String id) async {
    final response = await http.get(Uri.parse('$baseUrl/users/$id'));
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> createUser(String name) async {
    final response = await http.post(
      Uri.parse('$baseUrl/users'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'name': name}),
    );
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<void> replaceUser(String id, String name) async {
    await http.put(Uri.parse('$baseUrl/users/$id'), body: jsonEncode({'id': id, 'name': name}));
  }

  Future<void> renameUser(String id, String name) async {
    final request = http.Request('PATCH', Uri.parse('$baseUrl/users/$id'))
      ..headers['Content-Type'] = 'application/json'
      ..body = jsonEncode({'name': name});
    final client = http.Client();
    try {
      final response = await client.send(request);
      await response.stream.bytesToString();
    } finally {
      client.close();
    }
  }

  Future<void> deleteUser(String id) async {
    await http.delete(Uri.parse(baseUrl + '/users/' + id));
  }

  Future<String> avatar(String id) => http.read(Uri.parse('$baseUrl/users/$id/avatar'));
}
