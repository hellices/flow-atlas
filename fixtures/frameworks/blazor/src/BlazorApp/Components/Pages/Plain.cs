using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

namespace BlazorApp.Components.Pages;

// A routable component written as a class: the RouteAttribute @page compiles to.
[Route("/plain")]
public class Plain : ComponentBase
{
    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        builder.OpenElement(0, "h1");
        builder.AddContent(1, "A component without markup");
        builder.CloseElement();
    }
}
