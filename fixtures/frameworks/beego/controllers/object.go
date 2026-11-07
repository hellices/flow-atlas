package controllers

import "github.com/beego/beego/v2/server/web"

// ObjectController's routes are its `@router` annotations, which `bee generate routers` writes to
// routers/commentsRouter.go for web.Include and web.NSInclude.
type ObjectController struct {
	web.Controller
}

// @Title Create
// @router / [post]
func (o *ObjectController) Post() { o.Ctx.WriteString("create") }

// @Title Get
// @router /:objectId [get]
func (o *ObjectController) Get() { o.Ctx.WriteString("get " + o.Ctx.Input.Param(":objectId")) }

// @Title GetAll
// @router / [get]
func (o *ObjectController) GetAll() { o.Ctx.WriteString("all") }

// @Title Update
// @router /:objectId [put]
func (o *ObjectController) Put() { o.Ctx.WriteString("update " + o.Ctx.Input.Param(":objectId")) }

// @Title Delete
// @router /:objectId [delete]
func (o *ObjectController) Delete() { o.Ctx.WriteString("delete " + o.Ctx.Input.Param(":objectId")) }
