package com.example.client;

import java.util.List;

public record RepoPage(List<Repo> items, Integer total) {
}
