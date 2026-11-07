// Asks Dart Frog which routes the application serves. `dart_frog build` renders the server's router from the route
// configuration `buildRouteConfiguration` reads from `routes/` (package dart_frog_gen, the CLI's own generator), and
// fails on a route conflict or a rogue route; that configuration's endpoints, the routes `dart_frog list` prints, are
// the paths the built server routes. The built server is then started and each endpoint requested with every method Dart Frog knows: a route takes the
// methods its handler answers (a handler decides them, refusing the others with 405), `*` when it answers them all. A
// wildcard `[...name]` route is also requested with nothing after its `/`. Each file of `public/`, which the server
// serves by itself, is requested too.
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:dart_frog/dart_frog.dart' show HttpMethod;
import 'package:dart_frog_gen/dart_frog_gen.dart';

final _param = RegExp(r'<[^>]+>');

String canonical(String path) {
  final out = path.replaceAll(_param, '{}').replaceAll(RegExp(r'/+$'), '');
  return out.isEmpty ? '/' : out;
}

/// The paths each endpoint pattern stands for, as a regex, to check that a sample is that endpoint's alone.
RegExp matcher(String endpoint, bool wildcard) {
  final pattern = endpoint.split(_param).map(RegExp.escape).join('[^/]+');
  return RegExp('^${pattern == '/' ? '' : pattern}${wildcard ? '(/.*)?' : '/?'}\$');
}

Future<String> dartFrog(List<String> args) async {
  final result = await Process.run(Platform.resolvedExecutable, ['run', 'dart_frog_cli:dart_frog', ...args]);
  stderr.write(result.stderr);
  if (result.exitCode != 0) throw StateError('dart_frog ${args.join(' ')}: ${result.stdout}');
  return result.stdout as String;
}

Future<void> main() async {
  final config = buildRouteConfiguration(Directory.current);
  if (config.rogueRoutes.isNotEmpty) throw StateError('rogue routes: ${config.rogueRoutes.map((r) => r.path)}');
  final listed = (await dartFrog(['list', '--plain', '.'])).split('\n').where((l) => l.isNotEmpty).toSet();
  if (!(listed.length == config.endpoints.length && listed.containsAll(config.endpoints.keys))) {
    throw StateError('dart_frog list prints $listed, not ${config.endpoints.keys}');
  }

  // `dart_frog build` resolves the project's packages again, rewriting pubspec.lock: it is put back as it was.
  final lock = File('pubspec.lock');
  final locked = lock.readAsStringSync();
  try {
    stderr.write(await dartFrog(['build']));
  } finally {
    lock.writeAsStringSync(locked);
  }

  final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = probe.port;
  await probe.close();
  final server = await Process.start(Platform.resolvedExecutable, ['build/bin/server.dart'], environment: {'PORT': '$port'});
  server.stderr.listen(stderr.add);
  final lines = server.stdout.transform(utf8.decoder).transform(const LineSplitter()).asBroadcastStream();
  await lines.firstWhere((line) => line.contains('Running on'));
  lines.listen(stderr.writeln);

  final client = HttpClient();
  final base = Uri.parse('http://127.0.0.1:$port');

  /// The status the server answers [method] [path] with, and its body.
  Future<(int, String)> request(String method, String path) async {
    final req = await client.openUrl(method, base.replace(path: path));
    final res = await req.close();
    return (res.statusCode, await res.transform(utf8.decoder).join());
  }

  /// The methods the server answers [path] with: neither the router's 404 nor the handler's 405.
  Future<Set<String>> answered(String path) async {
    final methods = <String>{};
    for (final m in HttpMethod.values) {
      final (status, body) = await request(m.value, path);
      if (status == HttpStatus.methodNotAllowed) continue;
      if (status == HttpStatus.notFound && body == 'Route not found') continue;
      methods.add(m.value);
    }
    return methods;
  }

  final every = HttpMethod.values.map((m) => m.value).toSet();
  final routes = <Map<String, String>>[];
  void add(Set<String> methods, String path, String raw) {
    final names = methods.containsAll(every) ? ['*'] : (methods.toList()..sort());
    for (final m in names) {
      routes.add({'method': m, 'path': path, 'raw': raw});
    }
  }

  final matchers = {
    for (final MapEntry(key: endpoint, value: files) in config.endpoints.entries)
      endpoint: matcher(endpoint, files.any((f) => f.wildcard)),
  };
  for (final MapEntry(key: endpoint, value: files) in config.endpoints.entries) {
    if (files.length != 1) throw StateError('$endpoint resolves to ${files.map((f) => f.path)}');
    final file = files.single;
    final raw = 'routes/${file.path.replaceFirst('../routes/', '')}';
    final base = endpoint.replaceAll(_param, 'value1');
    final sample = file.wildcard ? '${base == '/' ? '' : base}/rest/of/it' : base;
    final others = [for (final MapEntry(key: e, value: m) in matchers.entries) if (e != endpoint && m.hasMatch(sample)) e];
    if (others.isNotEmpty) throw StateError('$sample of $endpoint would also be $others');
    final methods = await answered(sample);
    if (methods.isEmpty) throw StateError('nothing answers $sample of $endpoint');
    if (!file.wildcard) {
      add(methods, canonical(endpoint), raw);
      continue;
    }
    add(methods, '${canonical(endpoint) == '/' ? '' : canonical(endpoint)}/{**}', raw);
    // A wildcard the server also dispatches with nothing after its `/` serves its directory's path too.
    final parent = await answered('${base == '/' ? '' : base}/');
    if (parent.isNotEmpty) add(parent, canonical(endpoint), raw);
  }

  final public = Directory('public');
  if (config.serveStaticFiles && public.existsSync()) {
    final files = public.listSync(recursive: true).whereType<File>().toList()..sort((a, b) => a.path.compareTo(b.path));
    for (final file in files) {
      final path = '/${file.path.substring(public.path.length + 1).replaceAll(r'\', '/')}';
      final (status, body) = await request('GET', path);
      if (status != HttpStatus.ok || body != file.readAsStringSync()) throw StateError('$path is not served from ${file.path}');
      add(await answered(path), path, file.path.replaceAll(r'\', '/'));
    }
  }

  client.close(force: true);
  server.kill();
  await server.exitCode;
  Directory('build').deleteSync(recursive: true);

  final library = await Isolate.resolvePackageUri(Uri.parse('package:dart_frog/dart_frog.dart'));
  final pubspec = File.fromUri(library!.resolve('../pubspec.yaml')).readAsStringSync();
  final version = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)!.group(1);
  stdout.writeln(jsonEncode({'framework': 'dart_frog', 'version': version, 'routes': routes}));
}
