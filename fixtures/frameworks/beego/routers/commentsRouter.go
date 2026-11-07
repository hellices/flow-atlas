package routers

import (
	beego "github.com/beego/beego/v2/server/web"
	"github.com/beego/beego/v2/server/web/context/param"
)

func init() {

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:CMSController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:CMSController"],
        beego.ControllerComments{
            Method: "AllBlock",
            Router: `/all/:key`,
            AllowHTTPMethods: []string{"get","post"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:CMSController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:CMSController"],
        beego.ControllerComments{
            Method: "StaticBlock",
            Router: `/staticblock/:key`,
            AllowHTTPMethods: []string{"get"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"],
        beego.ControllerComments{
            Method: "Post",
            Router: `/`,
            AllowHTTPMethods: []string{"post"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"],
        beego.ControllerComments{
            Method: "GetAll",
            Router: `/`,
            AllowHTTPMethods: []string{"get"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"],
        beego.ControllerComments{
            Method: "Get",
            Router: `/:objectId`,
            AllowHTTPMethods: []string{"get"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"],
        beego.ControllerComments{
            Method: "Put",
            Router: `/:objectId`,
            AllowHTTPMethods: []string{"put"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

    beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"] = append(beego.GlobalControllerRouter["example.com/beegoroutes/controllers:ObjectController"],
        beego.ControllerComments{
            Method: "Delete",
            Router: `/:objectId`,
            AllowHTTPMethods: []string{"delete"},
            MethodParams: param.Make(),
            Filters: nil,
            Params: nil})

}
