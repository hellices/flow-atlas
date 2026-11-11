import 'dart:io';

import 'package:path_provider/path_provider.dart';

class LoggerService {
  Future<File> exportLogs(String contents) async {
    final tempDir = await getTemporaryDirectory();
    final dateTime = DateTime.now().toIso8601String();
    final filePath = '${tempDir.path}/app_log_$dateTime.log';
    return File(filePath).writeAsString(contents);
  }
}
