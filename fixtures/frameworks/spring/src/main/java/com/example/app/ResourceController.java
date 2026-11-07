package com.example.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The URI patterns of the guide: wildcards, regular expressions and the rest of the path. */
@RestController
@RequestMapping("/library")
public class ResourceController {

	@GetMapping("/pages/t?st.html")
	public String page() {
		return "page";
	}

	@GetMapping("/resources/*.png")
	public String image() {
		return "image";
	}

	@GetMapping("/projects/{project:[a-z]+}/versions")
	public String versions(@PathVariable String project) {
		return project;
	}

	@GetMapping("/{name:[a-z-]+}-{version:\\d\\.\\d\\.\\d}{ext:\\.[a-z]+}")
	public String handle(@PathVariable String name, @PathVariable String version, @PathVariable String ext) {
		return name + version + ext;
	}

	@GetMapping("/resources/{*file}")
	public String file(@PathVariable String file) {
		return file;
	}

	@GetMapping("/archive/**")
	public String archive() {
		return "archive";
	}
}
