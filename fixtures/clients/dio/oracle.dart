// Makes every request the app's repositories make once: points the app's Dio clients at the recording server, as the
// app configures them with its API host, and calls each public method of each repository with ARG for a String
// argument and ARG_NUMBER for an int.
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:mirrors';

import 'package:app/data/api_client.dart';
import 'package:app/data/billing_repository.dart';
import 'package:app/data/user_repository.dart';

Future<void> main() async {
  final host = Platform.environment['RECORD_URL']!;
  final arg = Platform.environment['ARG']!;
  final number = int.parse(Platform.environment['ARG_NUMBER']!);
  final repositories = <Object>[
    UserRepository(createApiClient(host, token: 'token')),
    BillingRepository(createBillingClient(host)),
  ];
  for (final repository in repositories) {
    final mirror = reflect(repository);
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
  final library = await Isolate.resolvePackageUri(Uri.parse('package:dio/dio.dart'));
  final pubspec = File.fromUri(library!.resolve('../pubspec.yaml')).readAsStringSync();
  final version = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)!.group(1);
  stdout.writeln(jsonEncode({'library': 'dio', 'version': version}));
}
