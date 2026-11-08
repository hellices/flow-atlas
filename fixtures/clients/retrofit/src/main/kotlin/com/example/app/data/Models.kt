package com.example.app.data

import kotlinx.serialization.Serializable

@Serializable
data class User(val id: String = "", val name: String = "")

@Serializable
data class UserPage(val items: List<User> = emptyList(), val next: String? = null)

@Serializable
data class NewUser(val name: String, val email: String)

@Serializable
data class UserPatch(val name: String)

@Serializable
data class RevokeSessions(val reason: String)

@Serializable
data class Token(val accessToken: String = "")

@Serializable
data class Repo(val name: String = "")

@Serializable
data class RepoPage(val items: List<Repo> = emptyList())

@Serializable
data class Report(val year: Int = 0, val total: Long = 0)

@Serializable
data class Event(val name: String)
