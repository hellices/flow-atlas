package com.example.app

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

const val NOTES = "/notes"

/** Suspending handler methods, which WebFlux runs as coroutines. */
@RestController
@RequestMapping(NOTES)
class NoteController {

	@GetMapping
	suspend fun list(): List<String> = listOf()

	@GetMapping("/{id}")
	suspend fun get(@PathVariable id: Long): String = "note $id"

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	suspend fun add() {
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	suspend fun remove(@PathVariable id: Long) {
	}
}
