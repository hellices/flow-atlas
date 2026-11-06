package com.example.course;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/courses")
public class CourseController {

    @GetMapping("/{id}/detail")
    public Object detail(@PathVariable Long id) { return null; }

    @GetMapping("/{id}/related")
    public Object related(@PathVariable Long id) { return null; }

    @PostMapping
    public Object create(@RequestBody Object course) { return null; }
}
