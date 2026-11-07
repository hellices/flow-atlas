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

@RestController
@RequestMapping(NOTES)
class NoteController {

	@GetMapping
	fun list(): List<String> = listOf()

	@GetMapping("/{id}")
	fun get(@PathVariable id: Long): String = "note $id"

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	fun add() {
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	fun remove(@PathVariable id: Long) {
	}
}
