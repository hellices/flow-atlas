package controllers

import "github.com/beego/beego/v2/server/web"

// ReportController is registered with AutoRouter: each exported method is a path from the controller's name and the
// method's.
type ReportController struct {
	web.Controller
}

func (r *ReportController) Summary() { r.Ctx.WriteString("summary") }
func (r *ReportController) Detail()  { r.Ctx.WriteString("detail") }

// StatusController is registered with AutoPrefix.
type StatusController struct {
	web.Controller
}

func (s *StatusController) Ping() { s.Ctx.WriteString("pong") }
