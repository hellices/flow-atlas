using System.Net.Http.Json;

namespace App.Clients;

// A named client: IHttpClientFactory creates the HttpClient configured under ApiClients.Reports (".../api/v2/").
public sealed class ReportsService(IHttpClientFactory httpClientFactory)
{
    public async Task<Report?> GetReportAsync(int year)
    {
        HttpClient client = httpClientFactory.CreateClient(ApiClients.Reports);
        return await client.GetFromJsonAsync<Report>($"reports/{year}");
    }

    public async Task ExportReportAsync(int year, string format)
    {
        HttpClient client = httpClientFactory.CreateClient(ApiClients.Reports);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"reports/{year}/export?format={format}");
        request.Headers.Add("X-Request-Id", Guid.NewGuid().ToString());
        using HttpResponseMessage response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    public async Task<bool> ReportExistsAsync(int year)
    {
        HttpClient client = httpClientFactory.CreateClient(ApiClients.Reports);
        using var request = new HttpRequestMessage(HttpMethod.Head, $"reports/{year}");
        using HttpResponseMessage response = await client.SendAsync(request);
        return response.IsSuccessStatusCode;
    }
}
