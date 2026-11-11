namespace Catalog.API;

public static class CatalogApi
{
    public static IEndpointRouteBuilder MapCatalogApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("api/catalog");
        api.MapGet("/items/{id:int}/pic", GetItemPictureById).WithName("GetItemPicture");
        return app;
    }

    public static async Task<IResult> GetItemPictureById(int id) => Results.NotFound();
}
