package com.example.platform.internal.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/internal")
class InternalController {
    private final AggregationService service;

    InternalController(AggregationService service) {
        this.service = service;
    }

    @PostMapping("/collection/{collectionName}")
    AggregationResult aggregate(@PathVariable String collectionName, @RequestBody AggregationRequest request) {
        return service.aggregate(collectionName, request);
    }

    @GetMapping("/update-status")
    UpdateStatus status() {
        return service.status();
    }
}
