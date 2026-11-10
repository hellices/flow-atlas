// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package admin

import (
	"net/http"

	"example.com/gozeroroutes/internal/logic/admin"
	"example.com/gozeroroutes/internal/svc"
	"github.com/zeromicro/go-zero/rest/httpx"
)

func DashboardHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l := admin.NewDashboardLogic(r.Context(), svcCtx)
		resp, err := l.Dashboard()
		if err != nil {
			httpx.ErrorCtx(r.Context(), w, err)
		} else {
			httpx.OkJsonCtx(r.Context(), w, resp)
		}
	}
}
