package com.example.client;

import java.util.List;

public record UserPage(List<User> items, Integer total) {
}
