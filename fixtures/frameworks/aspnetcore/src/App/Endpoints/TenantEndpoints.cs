namespace App.Endpoints;

public static class TenantEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/tenants", async context =>
        {
            await context.Response.WriteAsJsonAsync(new { Message = "All tenants" });
        });

        var tenant = app.MapGroup("/tenants/{tenantId}");
        tenant.MapGet("/", (string tenantId) => $"Tenant {tenantId}");
        tenant.MapGroup("/projects").MapGet("/{projectId?}", (string tenantId, int? projectId) => $"{tenantId} {projectId}");
    }
}
