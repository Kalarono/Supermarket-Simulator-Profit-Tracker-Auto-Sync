using System.Text.Json;

namespace SupermarketTrackerSync;

public sealed class ProductMappingProvider : IGameDataProvider
{
    private readonly IReadOnlyDictionary<int, GameProduct> _products;
    private readonly IReadOnlyDictionary<int, GamePricingData> _pricing;
    public ProductMappingProvider(IEnumerable<GameProduct> products, IEnumerable<GamePricingData>? pricing = null)
    {
        var rows = products.ToArray();
        if (rows.Any(x => x.ProductId <= 0)) throw new InvalidDataException("Invalid ProductID in mapping");
        if (rows.GroupBy(x => x.ProductId).Any(g => g.Count() > 1)) throw new InvalidDataException("Duplicate ProductID in mapping");
        if (rows.Any(x => x.MappingStatus == "mapped" && (string.IsNullOrWhiteSpace(x.TrackerKey) ||
            (x.AuditStatus is not null && !new[]{"confirmed-exact","confirmed-alias","confirmed-metadata"}.Contains(x.AuditStatus)))))
            throw new InvalidDataException("Unconfirmed mapping marked applicable");
        var ambiguous = rows.Where(x => x.TrackerKey is not null && x.MappingStatus == "mapped")
            .GroupBy(x => x.TrackerKey, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1).ToArray();
        if (ambiguous.Length > 0) throw new InvalidDataException("Ambiguous tracker mapping: " + ambiguous[0].Key);
        _products = rows.ToDictionary(x => x.ProductId);
        var priceRows = pricing?.ToArray() ?? [];
        if (priceRows.GroupBy(x => x.ProductId).Any(g => g.Count() > 1) ||
            priceRows.Any(x => x.ProductId <= 0 || x.PurchaseQuantity <= 0 || x.OptimumProfitRate < 0 ||
                !_products.TryGetValue(x.ProductId, out var product) || product.AssetName != x.AssetName))
            throw new InvalidDataException("Invalid or stale game pricing data");
        _pricing = priceRows.ToDictionary(x => x.ProductId);
    }
    public GameProduct? Find(int productId) => _products.GetValueOrDefault(productId);
    public GamePricingData? FindPricing(int productId) => _pricing.GetValueOrDefault(productId);
    public static ProductMappingProvider LoadBuiltIn()
    {
        using var stream = typeof(ProductMappingProvider).Assembly.GetManifestResourceStream("Tracker.product-map.json")
            ?? throw new InvalidDataException("Built-in ProductID mapping resource is missing");
        var data = JsonSerializer.Deserialize<List<GameProduct>>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        using var pricingStream = typeof(ProductMappingProvider).Assembly.GetManifestResourceStream("Tracker.product-pricing.json")
            ?? throw new InvalidDataException("Built-in product pricing resource is missing");
        using var document = JsonDocument.Parse(pricingStream);
        var pricing = JsonSerializer.Deserialize<List<GamePricingData>>(document.RootElement.GetProperty("products"),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        return new ProductMappingProvider(data ?? throw new InvalidDataException("Built-in mapping is empty"), pricing);
    }
    public static ProductMappingProvider Load(string path)
    {
        if (!File.Exists(path)) return new ProductMappingProvider(Array.Empty<GameProduct>());
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var data = JsonSerializer.Deserialize<List<GameProduct>>(fs, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        return new ProductMappingProvider(data ?? new List<GameProduct>());
    }
}
