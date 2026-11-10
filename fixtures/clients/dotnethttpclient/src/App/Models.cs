namespace App;

public sealed record User(int Id, string Name, string Role);

public sealed record OrderItem(string Sku, int Quantity);

public sealed record Project(string Id, string Name);

public sealed record Report(int Year, string Title);
