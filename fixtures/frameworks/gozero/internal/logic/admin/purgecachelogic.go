// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package admin

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"github.com/zeromicro/go-zero/core/logx"
)

type PurgeCacheLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewPurgeCacheLogic(ctx context.Context, svcCtx *svc.ServiceContext) *PurgeCacheLogic {
	return &PurgeCacheLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *PurgeCacheLogic) PurgeCache() error {
	// todo: add your logic here and delete this line

	return nil
}
