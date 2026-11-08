package com.example.client;

import java.util.List;

public record ProjectPage(List<Project> items, Integer total) {
}
