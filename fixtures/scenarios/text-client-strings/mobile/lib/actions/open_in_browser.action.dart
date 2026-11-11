import 'package:url_launcher/url_launcher.dart';

class OpenInBrowserAction {
  Future<void> open(Store store) async {
    final serverEndpoint = store.get(StoreKey.serverEndpoint).replaceFirst('/api', '');
    await launchUrl(Uri.parse(serverEndpoint), mode: LaunchMode.externalApplication);
  }
}
