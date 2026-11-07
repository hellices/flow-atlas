// Code scaffolded by goctl. Safe to edit.
// goctl 1.10.2

package event

import (
	"context"

	"example.com/gozeroroutes/internal/svc"
	"example.com/gozeroroutes/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type StreamEventsLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewStreamEventsLogic(ctx context.Context, svcCtx *svc.ServiceContext) *StreamEventsLogic {
	return &StreamEventsLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *StreamEventsLogic) StreamEvents(client chan<- *types.EventMessage) error {
	// todo: add your logic here and delete this line

	return nil
}
