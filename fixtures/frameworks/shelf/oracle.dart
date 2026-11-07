// Asks shelf_router which routes the application serves. A Router keeps no list of its routes that a program can read,
// so the routes are recorded as the application registers them, on routers that are shelf_router's own `Router` with
// each registration noted (`add`, which every verb method calls, `all` and `mount`) and its handler tagged with the
// registration's number. A router mounted on another is found by its handler, the router's `call`. Each route is then
// requested through the application's router, and only the route whose own handler answers counts, so what is written
// is what shelf_router dispatches. A parameter whose regular expression takes `/` and ends the route is the rest of
// the path; it is also requested with nothing there, to learn whether shelf_router dispatches that path to it as well.
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

import 'package:shelf_fixture/app.dart';

class Registration {
  Registration(this.id, this.verb, this.route);
  final String id, verb, route;
}

class Mount {
  Mount(this.prefix, this.handler);
  final String prefix;
  final Handler handler;
}

final registrations = <Registration>[];

// ignore: subtype_of_sealed_class
class RecordingRouter extends Router {
  final entries = <Object>[];
  bool _mounting = false;

  @override
  void add(String verb, String route, Function handler) {
    final r = Registration('${registrations.length}', verb.toUpperCase(), route);
    registrations.add(r);
    entries.add(r);
    super.add(verb, route, tagged(handler, route, r.id));
  }

  @override
  void all(String route, Function handler) {
    if (_mounting) return super.all(route, handler);
    final r = Registration('${registrations.length}', '*', route);
    registrations.add(r);
    entries.add(r);
    super.all(route, tagged(handler, route, r.id));
  }

  @override
  void mount(String prefix, Handler handler) {
    entries.add(Mount(prefix, handler));
    _mounting = true;
    try {
      super.mount(prefix, handler);
    } finally {
      _mounting = false;
    }
  }
}

/// [handler], taking the request and the route's parameters as shelf_router passes them, with its response tagged.
Function tagged(Function handler, String route, String id) {
  Future<Response> tag(Object? response) async => (await response as Response).change(headers: {'x-route': id});
  if (handler is Handler) return (Request r) => tag(handler(r));
  return switch (params(route).length) {
    0 => (Request r) => tag(Function.apply(handler, [r])),
    1 => (Request r, String a) => tag(Function.apply(handler, [r, a])),
    2 => (Request r, String a, String b) => tag(Function.apply(handler, [r, a, b])),
    3 => (Request r, String a, String b, String c) => tag(Function.apply(handler, [r, a, b, c])),
    final n => throw UnsupportedError('$n parameters in $route'),
  };
}

/// shelf_router's route syntax: `<name>` or `<name|regexp>`, `[^/]+` when no regexp is given.
final _param = RegExp(r'<([^>|]+)(?:\|([^>]*))?>');

List<RegExp> params(String route) => [
  for (final m in _param.allMatches(route)) RegExp('^(?:${m[2] ?? r'[^/]+'})\$'),
];

/// Whether the parameter takes `/`: the rest of the path, as one segment or more.
bool spans(RegExp param) => param.hasMatch('rest/of/it');

String sample(String route, {bool empty = false}) => route.replaceAllMapped(_param, (m) {
  final param = RegExp('^(?:${m[2] ?? r'[^/]+'})\$');
  if (spans(param)) return empty ? '' : 'rest/of/it';
  return ['value1', '42'].firstWhere(param.hasMatch, orElse: () => throw StateError('no sample for ${m[0]}'));
});

String canonical(String route) {
  var out = route.replaceAllMapped(_param, (m) => spans(RegExp('^(?:${m[2] ?? r'[^/]+'})\$')) ? '{**}' : '{}');
  if (out.contains('{**}') && !out.endsWith('/{**}')) throw StateError('$route takes `/` before its end');
  out = out.replaceAll(RegExp(r'/+$'), '');
  return out.isEmpty ? '/' : out;
}

/// Every route under the prefixes of the routers it is mounted in.
Iterable<(Registration, String)> walk(RecordingRouter router, String prefix, List<RecordingRouter> routers) sync* {
  for (final entry in router.entries) {
    if (entry is Registration) {
      yield (entry, '${prefix.replaceAll(RegExp(r'/$'), '')}${entry.route}');
    } else if (entry is Mount) {
      final inner = routers.where((r) => r.call == entry.handler);
      if (inner.length != 1) throw StateError('${entry.prefix} mounts no router of the application');
      yield* walk(inner.single, '${prefix.replaceAll(RegExp(r'/$'), '')}${entry.prefix}', routers);
    }
  }
}

Future<void> main() async {
  final routers = <RecordingRouter>[];
  final root = buildRouter(() => RecordingRouter()..let(routers.add)) as RecordingRouter;

  Future<String?> answers(String method, String path) async {
    final response = await root.call(Request(method, Uri.parse('http://localhost$path')));
    return response.headers['x-route'];
  }

  final routes = <Map<String, String>>[];
  for (final (r, route) in walk(root, '', routers)) {
    final method = r.verb == '*' ? 'PATCH' : r.verb;
    final path = sample(route);
    final answered = await answers(method, path);
    if (answered != r.id) throw StateError('$method $path is answered by route $answered, not by $route that registers it');
    final served = canonical(route);
    routes.add({'method': r.verb, 'path': served, 'raw': route});
    // A rest of the path that may be empty: shelf_router dispatches its route's path with nothing after the `/` too.
    if (served.endsWith('/{**}') && await answers(method, sample(route, empty: true)) == r.id) {
      routes.add({'method': r.verb, 'path': served.substring(0, served.length - '/{**}'.length).let((p) => p.isEmpty ? '/' : p), 'raw': route});
    }
  }

  final library = await Isolate.resolvePackageUri(Uri.parse('package:shelf_router/shelf_router.dart'));
  final pubspec = File.fromUri(library!.resolve('../pubspec.yaml')).readAsStringSync();
  final version = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)!.group(1);
  stdout.writeln(jsonEncode({'framework': 'shelf_router', 'version': version, 'routes': routes}));
}

extension<T> on T {
  R let<R>(R Function(T) f) => f(this);
}
