package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// registerAdmin adds its routes to the group it is given, wherever that group is served.
func registerAdmin(admin *gin.RouterGroup) {
	admin.GET("/dashboard", func(c *gin.Context) { c.String(http.StatusOK, "dashboard") })
	admin.DELETE("/cache", func(c *gin.Context) { c.String(http.StatusOK, "cleared") })
}
