// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package logic

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type FooBarBazQuxLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewFooBarBazQuxLogic(ctx context.Context, svcCtx *svc.ServiceContext) *FooBarBazQuxLogic {
	return &FooBarBazQuxLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *FooBarBazQuxLogic) FooBarBazQux() (resp *types.PingResp, err error) {
	// todo: add your logic here and delete this line

	return
}
