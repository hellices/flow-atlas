// Makes every request the app's services make once: points them at the recording server, as the app configures them
// with its API's origin (and the catalog service's host), and calls each public method of each service with ARG for a
// String argument and ARG_NUMBER for an int.
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:mirrors';

import 'package:app/data/catalog_api.dart';
import 'package:app/data/users_service.dart';

Future<void> main() async {
  final origin = Platform.environment['RECORD_URL']!;
  final arg = Platform.environment['ARG']!;
  final number = int.parse(Platform.environment['ARG_NUMBER']!);
  final services = <Object>[UsersService(origin), CatalogApi(Uri.parse(origin).authority)];
  for (final service in services) {
    final mirror = reflect(service);
    for (final method in mirror.type.declarations.values.whereType<MethodMirror>()) {
      if (!method.isRegularMethod || method.isPrivate || method.isStatic) continue;
      final args = method.parameters.map((p) {
        if (p.type.reflectedType == String) return arg;
        if (p.type.reflectedType == int) return number;
        throw StateError('${MirrorSystem.getName(method.qualifiedName)}: no value for ${p.type}');
      }).toList();
      await (mirror.invoke(method.simpleName, args).reflectee as Future);
    }
  }
  final library = await Isolate.resolvePackageUri(Uri.parse('package:http/http.dart'));
  final pubspec = File.fromUri(library!.resolve('../pubspec.yaml')).readAsStringSync();
  final version = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)!.group(1);
  stdout.writeln(jsonEncode({'library': 'http', 'version': version}));
  await stdout.flush();
  // The catalog's client keeps its idle connection open; the app would close it when it is done with the service.
  exit(0);
}
