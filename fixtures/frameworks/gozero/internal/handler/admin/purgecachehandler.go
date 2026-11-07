// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package admin

import (
	"net/http"

	"example.com/gozeroroutes/internal/logic/admin"
	"example.com/gozeroroutes/internal/svc"
	"github.com/zeromicro/go-zero/rest/httpx"
)

func PurgeCacheHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l := admin.NewPurgeCacheLogic(r.Context(), svcCtx)
		err := l.PurgeCache()
		if err != nil {
			httpx.ErrorCtx(r.Context(), w, err)
		} else {
			httpx.Ok(w)
		}
	}
}
