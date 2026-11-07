package com.example.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/** The URI patterns of the guide: wildcards, regular expressions and the rest of the path. */
@RestController
@RequestMapping("/library")
public class ResourceController {

	@GetMapping("/resources/ima?e.png")
	public Mono<String> image() {
		return Mono.just("image");
	}

	@GetMapping("/resources/*.png")
	public Mono<String> images() {
		return Mono.just("images");
	}

	@GetMapping("/resources/**")
	public Mono<String> resources() {
		return Mono.just("resources");
	}

	@GetMapping("/projects/{project}/versions")
	public Mono<String> versions(@PathVariable String project) {
		return Mono.just(project);
	}

	@GetMapping("/{name:[a-z-]+}-{version:\\d\\.\\d\\.\\d}{ext:\\.[a-z]+}")
	public Mono<String> handle(@PathVariable String name, @PathVariable String version, @PathVariable String ext) {
		return Mono.just(name + version + ext);
	}

	@GetMapping("/files/{*path}")
	public Mono<String> file(@PathVariable String path) {
		return Mono.just(path);
	}
}
