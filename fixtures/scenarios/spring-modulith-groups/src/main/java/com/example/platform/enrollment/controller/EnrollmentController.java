package com.example.platform.enrollment.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
class EnrollmentController {
    private final EnrollmentService service;

    EnrollmentController(EnrollmentService service) {
        this.service = service;
    }

    @PostMapping(value = "/api/enrollment", consumes = "application/json")
    ResponseEntity<Void> enroll(@RequestBody EnrollmentRequest request) {
        service.enroll(request);
        return ResponseEntity.accepted().build();
    }
}
