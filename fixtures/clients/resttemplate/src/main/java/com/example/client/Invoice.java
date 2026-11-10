package com.example.client;

import java.util.List;

public record Invoice(Long id, String status, List<String> lines) {
}
