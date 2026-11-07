// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package user

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type UserOrderLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewUserOrderLogic(ctx context.Context, svcCtx *svc.ServiceContext) *UserOrderLogic {
	return &UserOrderLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *UserOrderLogic) UserOrder(req *types.UserOrderReq) (resp *types.OrderResp, err error) {
	// todo: add your logic here and delete this line

	return
}
