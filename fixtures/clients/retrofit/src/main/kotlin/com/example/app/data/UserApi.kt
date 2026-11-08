package com.example.app.data

import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Call
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.Field
import retrofit2.http.FormUrlEncoded
import retrofit2.http.GET
import retrofit2.http.HEAD
import retrofit2.http.HTTP
import retrofit2.http.Header
import retrofit2.http.Headers
import retrofit2.http.Multipart
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Url

/**
 * The users service, at the configured `apiBaseUrl`. Each relative URL is resolved against that base as a link on a
 * page is, so `users/{id}` keeps the base's path, and `/health`, which starts with a `/`, replaces it.
 */
interface UserApi {
    @GET("users")
    suspend fun users(@Query("page") page: Int, @Query("q") query: String? = null): UserPage

    @GET("users/{id}")
    suspend fun user(@Path("id") id: String): User

    @POST("users")
    suspend fun createUser(@Body user: NewUser): User

    @PUT("users/{id}")
    suspend fun replaceUser(@Path("id") id: String, @Body user: NewUser): User

    @PATCH("users/{id}")
    suspend fun renameUser(@Path("id") id: String, @Body patch: UserPatch): User

    @DELETE("users/{id}")
    suspend fun deleteUser(@Path("id") id: String): Response<Unit>

    @HEAD("users/{id}")
    suspend fun userExists(@Path("id") id: String): Response<Void>

    @HTTP(method = "DELETE", path = "users/{id}/sessions", hasBody = true)
    suspend fun revokeSessions(@Path("id") id: String, @Body request: RevokeSessions): Response<Unit>

    @Headers("Cache-Control: max-age=640000")
    @GET("groups/{groupId}/users")
    suspend fun groupUsers(@Path("groupId") groupId: Long, @Query("sort") sort: String = "desc"): UserPage

    /** The next page, at the URL the previous page's `next` link names. */
    @GET
    suspend fun page(@Url url: String): UserPage

    @GET("/health")
    suspend fun health(): Response<Unit>

    @FormUrlEncoded
    @POST("auth/token")
    suspend fun token(@Field("username") username: String, @Field("password") password: String): Token

    @Multipart
    @PUT("users/{id}/photo")
    suspend fun uploadPhoto(
        @Path("id") id: String,
        @Part photo: MultipartBody.Part,
        @Part("description") description: RequestBody,
    ): User

    @GET("users/{id}/repos")
    fun repos(@Path("id") id: String, @Header("Authorization") authorization: String?): Call<RepoPage>
}
