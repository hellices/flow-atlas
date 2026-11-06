package com.example.platform.ingest.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
class IngestController {
    private final IngestService service;

    IngestController(IngestService service) {
        this.service = service;
    }

    @PostMapping(value = "/api/collections/{name}/events", consumes = "application/json")
    ResponseEntity<Void> ingest(@PathVariable String name, @RequestBody byte[] body) {
        service.accept(name, body);
        return ResponseEntity.accepted().build();
    }
}
