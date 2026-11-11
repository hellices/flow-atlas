class User {
  final String id;

  const User(this.id);

  factory User.fromJson(Map<String, dynamic> json) => User(json['id'] as String);
}
