import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

// Screen routes, not requests: the configuration leaves this file out of the call files.
class CourseCard extends StatelessWidget {
  const CourseCard({super.key, required this.id});

  final int id;

  @override
  Widget build(BuildContext context) => GestureDetector(onTap: () => context.push('/course/$id'));
}
