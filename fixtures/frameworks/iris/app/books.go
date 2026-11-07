package app

import (
	"github.com/kataras/iris/v12"
	"github.com/kataras/iris/v12/mvc"
)

// BookController is an Iris MVC controller: each method's name is its HTTP method and path, `By` a path parameter
// typed after the argument.
type BookController struct {
	Ctx iris.Context
}

func (c *BookController) Get() string                           { return "books" }
func (c *BookController) Post() string                          { return "created" }
func (c *BookController) GetBy(id int64) string                 { return "book" }
func (c *BookController) PutBy(id int64) string                 { return "updated" }
func (c *BookController) DeleteBy(id int64) string              { return "deleted" }
func (c *BookController) GetAuthors() string                    { return "authors" }
func (c *BookController) GetAuthorBy(name string) string        { return name }
func (c *BookController) GetFilesByWildcard(path string) string { return path }

// BeforeActivation adds a route whose path does not follow the naming.
func (c *BookController) BeforeActivation(b mvc.BeforeActivation) {
	b.Handle("GET", "/something/{id:int64}", "Something")
}

func (c *BookController) Something(id int64) string { return "something" }
