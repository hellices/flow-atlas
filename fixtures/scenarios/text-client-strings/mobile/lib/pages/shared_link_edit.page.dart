import 'package:flutter/material.dart';

class SharedLinkSlugField extends StatelessWidget {
  final TextEditingController slugController;

  const SharedLinkSlugField({super.key, required this.slugController});

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: slugController,
      decoration: InputDecoration(
        border: const OutlineInputBorder(),
        prefixText: slugController.text.isNotEmpty ? '/s/' : null,
      ),
    );
  }
}
