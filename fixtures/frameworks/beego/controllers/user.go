package controllers

import "github.com/beego/beego/v2/server/web"

type UserController struct {
	web.Controller
}

func (u *UserController) Get()  { u.Ctx.WriteString("get user") }
func (u *UserController) Post() { u.Ctx.WriteString("post user") }

func (u *UserController) GetUserById() { u.Ctx.WriteString("GetUserById " + u.Ctx.Input.Param(":id")) }
func (u *UserController) UpdateUser()  { u.Ctx.WriteString("UpdateUser") }
func (u *UserController) UserHome()    { u.Ctx.WriteString("UserHome") }
func (u *UserController) DeleteUser()  { u.Ctx.WriteString("DeleteUser") }
func (u *UserController) PatchUsers()  { u.Ctx.WriteString("PatchUsers") }
func (u *UserController) PutUsers()    { u.Ctx.WriteString("PutUsers") }
func (u *UserController) Profile()     { u.Ctx.WriteString("profile " + u.Ctx.Input.Param(":username")) }
func (u *UserController) Splat()       { u.Ctx.WriteString("splat " + u.Ctx.Input.Param(":splat")) }
func (u *UserController) Optional()    { u.Ctx.WriteString("optional " + u.Ctx.Input.Param(":id")) }
func (u *UserController) Numeric()     { u.Ctx.WriteString("numeric " + u.Ctx.Input.Param(":id")) }
func (u *UserController) Word()        { u.Ctx.WriteString("word " + u.Ctx.Input.Param(":hi")) }
func (u *UserController) Page()        { u.Ctx.WriteString("page " + u.Ctx.Input.Param(":id")) }
