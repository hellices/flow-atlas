namespace BlazorApp.Components.Pages;

// Route templates kept as constants, given to components with @attribute [Route(...)] instead of @page.
public static class RouteTemplates
{
    public const string Product = "/products/{category}/{id:guid}";
}
