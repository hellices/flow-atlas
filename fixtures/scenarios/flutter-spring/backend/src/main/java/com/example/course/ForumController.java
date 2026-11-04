package com.example.course;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/forum")
public class ForumController {

    @PostMapping("/courses/{courseId}/posts")
    public Object ask(@PathVariable Long courseId, @RequestBody Object post) { return null; }
}
