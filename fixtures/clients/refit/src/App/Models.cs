using System.Text.Json;
using System.Text.Json.Serialization;

namespace App;

public sealed record User(int Id, string Name, string Role);

public sealed record Rename(string Name);

public sealed record OrderItem(string Sku, int Quantity);

public sealed record Project(string Id, string Name);

public sealed record Report(int Year, string Title);

// The JSON types the generated clients read and write, from System.Text.Json's source generator.
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(Report))]
[JsonSerializable(typeof(List<Report>))]
[JsonSerializable(typeof(string))]
public sealed partial class AppJsonContext : JsonSerializerContext;
