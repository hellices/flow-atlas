// Package app holds the routes of Gin's routing guide (gin-gonic.com/en/docs/routing/): a route for each method, path
// parameters and a wildcard, groups and nested groups, versioned groups, Any, Handle and Match, and static files.
package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.New()
	Register(router)
	return router
}

// Register adds the application's routes to the engine.
func Register(router *gin.Engine) {

	router.GET("/", home)
	router.GET("/someGet", getting)
	router.POST("/somePost", posting)
	router.PUT("/somePut", putting)
	router.DELETE("/someDelete", deleting)
	router.PATCH("/somePatch", patching)
	router.HEAD("/someHead", head)
	router.OPTIONS("/someOptions", options)

	router.GET("/user/:name", user)
	router.GET("/user/:name/*action", userAction)
	router.POST("/user/:name/*action", userAction)
	// Exact routes are resolved before param routes, regardless of the order they were defined.
	router.GET("/user/groups", groups)

	router.Any("/anything", anything)
	router.Handle(http.MethodPost, "/handled", handled)
	router.Match([]string{http.MethodGet, http.MethodPost}, "/match", matched)

	v1 := router.Group("/v1")
	{
		v1.POST("/login", login)
		v1.POST("/submit", submit)
		v1.POST("/read", read)
	}
	v2 := router.Group("/v2")
	{
		v2.POST("/login", login)
		v2.POST("/submit", submit)
		v2.POST("/read", read)
	}

	api := router.Group("/api")
	{
		api.GET("/health", health)
		v1 := api.Group("/v1")
		{
			users := v1.Group("/users")
			users.GET("/", listUsers)
			users.GET("/:id", getUser)

			posts := v1.Group("/posts")
			posts.GET("/", listPosts)
			posts.GET("/:id", getPost)
		}
	}
	registerAdmin(router.Group("/admin", authRequired()))

	router.Static("/assets", "./app/assets")
	router.StaticFS("/more_static", http.Dir("./app/assets"))
	router.StaticFile("/favicon.ico", "./app/resources/favicon.ico")
}

func authRequired() gin.HandlerFunc {
	return func(c *gin.Context) { c.Next() }
}

func ok(c *gin.Context) { c.String(http.StatusOK, c.FullPath()) }

func home(c *gin.Context)       { ok(c) }
func getting(c *gin.Context)    { ok(c) }
func posting(c *gin.Context)    { ok(c) }
func putting(c *gin.Context)    { ok(c) }
func deleting(c *gin.Context)   { ok(c) }
func patching(c *gin.Context)   { ok(c) }
func head(c *gin.Context)       { c.Status(http.StatusOK) }
func options(c *gin.Context)    { c.Status(http.StatusOK) }
func user(c *gin.Context)       { c.String(http.StatusOK, "Hello %s", c.Param("name")) }
func groups(c *gin.Context)     { ok(c) }
func userAction(c *gin.Context) { c.String(http.StatusOK, c.Param("name")+" is "+c.Param("action")) }
func anything(c *gin.Context)   { ok(c) }
func handled(c *gin.Context)    { ok(c) }
func matched(c *gin.Context)    { ok(c) }
func login(c *gin.Context)      { ok(c) }
func submit(c *gin.Context)     { ok(c) }
func read(c *gin.Context)       { ok(c) }
func health(c *gin.Context)     { ok(c) }
func listUsers(c *gin.Context)  { ok(c) }
func getUser(c *gin.Context)    { ok(c) }
func listPosts(c *gin.Context)  { ok(c) }
func getPost(c *gin.Context)    { ok(c) }
