package com.example.platform.enrollment.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
class EnrollmentStatusController {
    private final EnrollmentStatusService service;

    EnrollmentStatusController(EnrollmentStatusService service) {
        this.service = service;
    }

    @PostMapping("/v1/enrollment/status")
    StatusResponse update(@RequestBody StatusRequest request) {
        return service.update(request);
    }

    @GetMapping("/v1/enrollment/status")
    StatusResponse read(@RequestParam String userId) {
        return service.read(userId);
    }
}
