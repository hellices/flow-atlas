// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package user

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type PatchUserLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewPatchUserLogic(ctx context.Context, svcCtx *svc.ServiceContext) *PatchUserLogic {
	return &PatchUserLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *PatchUserLogic) PatchUser(req *types.UpdateUserReq) (resp *types.UserResp, err error) {
	// todo: add your logic here and delete this line

	return
}
