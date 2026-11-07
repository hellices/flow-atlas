// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package user

import (
	"net/http"

	"example.com/gozeroroutes/internal/logic/user"
	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"
	"github.com/zeromicro/go-zero/rest/httpx"
)

func UserOrderHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req types.UserOrderReq
		if err := httpx.Parse(r, &req); err != nil {
			httpx.ErrorCtx(r.Context(), w, err)
			return
		}

		l := user.NewUserOrderLogic(r.Context(), svcCtx)
		resp, err := l.UserOrder(&req)
		if err != nil {
			httpx.ErrorCtx(r.Context(), w, err)
		} else {
			httpx.OkJsonCtx(r.Context(), w, resp)
		}
	}
}
