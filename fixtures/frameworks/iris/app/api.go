package app

import "github.com/kataras/iris/v12"

// registerAPI adds the API's routes to the party it is given, in nested parties.
func registerAPI(api iris.Party) {
	api.Get("/health", ok)
	v1 := api.Party("/v1")
	{
		v1.Get("/users", ok)
		v1.Post("/users", ok)
		v1.Get("/users/{id:uint64}", ok)
		v1.Put("/users/{id:uint64}", ok)
		v1.Delete("/users/{id:uint64}", ok)
	}
	v2 := api.Party("/v2", authenticated)
	v2.Get("/users/{id:uuid}", ok)
}
