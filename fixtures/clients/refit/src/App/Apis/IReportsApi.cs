using Refit;

namespace App.Apis;

[PathPrefix("/v2/reports")]
public interface IReportsApi
{
    [Get("/{year}")]
    Task<Report> GetReportAsync(int year);

    [Post("/{year}/export")]
    Task ExportReportAsync(int year, [Query] string format, [Header("X-Request-Id")] string requestId);
}
