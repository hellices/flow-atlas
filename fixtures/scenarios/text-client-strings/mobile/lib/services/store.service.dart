enum StoreKey { serverEndpoint }

class Store {
  final Map<StoreKey, String> _values = {};

  String get(StoreKey key) => _values[key] ?? '';
}
