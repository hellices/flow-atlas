// Package app holds the routes of Echo's guide (echo.labstack.com/guide/routing/ and /guide/static-files/): a route for
// each method, path parameters (a whole segment, and after static text within one), wildcards, a static path beside a
// parameter and a wildcard on the same prefix, Any (with a method-specific route on the same path), Match, groups with
// and without middleware, nested groups, and static files from a directory, an embedded filesystem and a single file.
package app

import (
	"embed"
	"net/http"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
)

//go:embed assets/images
var images embed.FS

func New() *echo.Echo {
	e := echo.New()

	e.GET("/", home)

	// Static wins over a parameter, which wins over a wildcard.
	e.GET("/users/profile", profile)
	e.GET("/users/:id", getUser)
	e.POST("/users", createUser)
	e.PUT("/users/:id", updateUser)
	e.DELETE("/users/:id", deleteUser)
	e.GET("/users/*", usersRest)

	e.GET("/files/*", serveFiles)
	e.GET("/releases/v:version/notes", releaseNotes)
	e.GET("/downloads/file.:ext", download)

	// Any takes every method, ones Echo does not know too; the GET on the same path takes precedence for GET.
	e.Any("/ping", pong)
	e.GET("/ping", pingGet)
	e.Match([]string{http.MethodGet, http.MethodPost}, "/form", handleForm)

	// A group with middleware also registers its own 404 routes (`/admin` and `/admin/*`); they serve no page.
	admin := e.Group("/admin", middleware.BasicAuth(authFn))
	admin.GET("/metrics", metrics)
	admin.GET("/users", listUsers)

	api := e.Group("/api")
	v1 := api.Group("/v1")
	v1.GET("/health", health)
	posts := v1.Group("/posts")
	posts.GET("", listPosts)
	posts.POST("", createPost)
	posts.GET("/:id", getPost)
	posts.Match([]string{http.MethodPut, http.MethodPatch}, "/:id", updatePost)
	posts.Any("/:id/comments", comments)

	// Static and StaticFS append `*` to the prefix: "/images/" serves "/images/*". A prefix without its last `/`
	// ("/images") would be "/images*", which also takes "/imagesX": left out.
	e.StaticFS("/images/", echo.MustSubFS(images, "assets/images"))
	e.File("/favicon.ico", "app/public/favicon.ico")
	// Serve any file from app/public under /*.
	e.Static("/", "app/public")
	return e
}

func authFn(_ *echo.Context, user, password string) (bool, error) {
	return user == "admin" && password == "secret", nil
}

func ok(c *echo.Context) error { return c.String(http.StatusOK, c.Path()) }

func home(c *echo.Context) error         { return ok(c) }
func profile(c *echo.Context) error      { return ok(c) }
func getUser(c *echo.Context) error      { return ok(c) }
func createUser(c *echo.Context) error   { return ok(c) }
func updateUser(c *echo.Context) error   { return ok(c) }
func deleteUser(c *echo.Context) error   { return ok(c) }
func usersRest(c *echo.Context) error    { return ok(c) }
func serveFiles(c *echo.Context) error   { return ok(c) }
func releaseNotes(c *echo.Context) error { return ok(c) }
func download(c *echo.Context) error     { return ok(c) }
func pong(c *echo.Context) error         { return ok(c) }
func pingGet(c *echo.Context) error      { return ok(c) }
func handleForm(c *echo.Context) error   { return ok(c) }
func metrics(c *echo.Context) error      { return ok(c) }
func listUsers(c *echo.Context) error    { return ok(c) }
func health(c *echo.Context) error       { return ok(c) }
func listPosts(c *echo.Context) error    { return ok(c) }
func createPost(c *echo.Context) error   { return ok(c) }
func getPost(c *echo.Context) error      { return ok(c) }
func updatePost(c *echo.Context) error   { return ok(c) }
func comments(c *echo.Context) error     { return ok(c) }
