import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

class ForumSection extends StatelessWidget {
  const ForumSection({super.key, required this.courseId, required this.dio});

  final int courseId;
  final Dio dio;

  Future<void> ask(String post) async {
    await dio.post(
      '/forum/courses/$courseId/posts',
      data: {'post': post},
    );
  }

  @override
  Widget build(BuildContext context) => const SizedBox();
}
