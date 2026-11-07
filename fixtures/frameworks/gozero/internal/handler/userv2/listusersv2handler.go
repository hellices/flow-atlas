// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package userv2

import (
	"net/http"

	"example.com/gozeroroutes/internal/logic/userv2"
	"example.com/gozeroroutes/internal/svc"
	"github.com/zeromicro/go-zero/rest/httpx"
)

func ListUsersV2Handler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l := userv2.NewListUsersV2Logic(r.Context(), svcCtx)
		resp, err := l.ListUsersV2()
		if err != nil {
			httpx.ErrorCtx(r.Context(), w, err)
		} else {
			httpx.OkJsonCtx(r.Context(), w, resp)
		}
	}
}
