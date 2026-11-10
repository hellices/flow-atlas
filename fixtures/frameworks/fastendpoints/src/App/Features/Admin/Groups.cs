using FastEndpoints;

namespace App.Features.Admin;

// A configuration group with a route prefix, and a sub-group under it.
public class Administration : Group
{
    public Administration()
    {
        Configure("admin", ep => ep.Description(x => x.WithTags("administration")));
    }
}

public class Sales : SubGroup<Administration>
{
    public Sales()
    {
        Configure("sales", ep => ep.Description(x => x.WithTags("sales")));
    }
}
