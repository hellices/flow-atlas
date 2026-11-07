// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package order

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type CreateOrderLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewCreateOrderLogic(ctx context.Context, svcCtx *svc.ServiceContext) *CreateOrderLogic {
	return &CreateOrderLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *CreateOrderLogic) CreateOrder(req *types.CreateOrderReq) (resp *types.OrderResp, err error) {
	// todo: add your logic here and delete this line

	return
}
