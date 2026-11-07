// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package userv2

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type ListUsersV2Logic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewListUsersV2Logic(ctx context.Context, svcCtx *svc.ServiceContext) *ListUsersV2Logic {
	return &ListUsersV2Logic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *ListUsersV2Logic) ListUsersV2() (resp []types.UserResp, err error) {
	// todo: add your logic here and delete this line

	return
}
