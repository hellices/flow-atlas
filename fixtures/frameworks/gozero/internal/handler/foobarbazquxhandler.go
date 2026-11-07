// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package handler

import (
	"net/http"

	"example.com/gozeroroutes/internal/logic"
	"example.com/gozeroroutes/internal/svc"
	"github.com/zeromicro/go-zero/rest/httpx"
)

func fooBarBazQuxHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l := logic.NewFooBarBazQuxLogic(r.Context(), svcCtx)
		resp, err := l.FooBarBazQux()
		if err != nil {
			httpx.ErrorCtx(r.Context(), w, err)
		} else {
			httpx.OkJsonCtx(r.Context(), w, resp)
		}
	}
}
