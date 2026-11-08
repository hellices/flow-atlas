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
data class Token(val accessToken: String = "")

@Serializable
data class Article(val title: String = "", val body: String = "")

@Serializable
data class ArticlePage(val items: List<Article> = emptyList())
