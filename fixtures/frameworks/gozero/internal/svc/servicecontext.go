// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package svc

import (
	"example.com/gozeroroutes/internal/config"
	"example.com/gozeroroutes/internal/middleware"
	"github.com/zeromicro/go-zero/rest"
)

type ServiceContext struct {
	Config    config.Config
	AdminAuth rest.Middleware
}

func NewServiceContext(c config.Config) *ServiceContext {
	return &ServiceContext{
		Config:    c,
		AdminAuth: middleware.NewAdminAuthMiddleware().Handle,
	}
}
