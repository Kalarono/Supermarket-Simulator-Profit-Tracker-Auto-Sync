using System.Text;
using System.Text.Json;

namespace SupermarketTrackerSync;

// Easy Save 3 writes some dictionary keys as bare integers. This lexical pass quotes only
// such keys outside strings; it does not rewrite values or use a regex over the save.
public static class Es3JsonAdapter
{
    public static byte[] Normalize(string input)
    {
        var output = new StringBuilder(input.Length + 128);
        var stack = new Stack<(char Kind, bool ExpectKey)>();
        bool inString = false, escaped = false;
        for (int i = 0; i < input.Length; i++)
        {
            char c = input[i];
            if (inString)
            {
                output.Append(c);
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') { inString = true; output.Append(c); continue; }
            if (c == '{') { stack.Push(('{', true)); output.Append(c); continue; }
            if (c == '[') { stack.Push(('[', false)); output.Append(c); continue; }
            if (c == '}' || c == ']')
            {
                if (stack.Count == 0 || stack.Pop().Kind != (c == '}' ? '{' : '['))
                    throw new JsonException("Unbalanced ES3 container");
                output.Append(c); continue;
            }
            if (c == ',' && stack.Count > 0 && stack.Peek().Kind == '{')
            {
                stack.Pop(); stack.Push(('{', true)); output.Append(c); continue;
            }
            if (c == ':' && stack.Count > 0 && stack.Peek().Kind == '{')
            {
                stack.Pop(); stack.Push(('{', false)); output.Append(c); continue;
            }
            if (stack.Count > 0 && stack.Peek() == ('{', true) && (char.IsDigit(c) || c == '-'))
            {
                int end = i;
                if (input[end] == '-') end++;
                while (end < input.Length && char.IsDigit(input[end])) end++;
                int colon = end;
                while (colon < input.Length && char.IsWhiteSpace(input[colon])) colon++;
                if (colon < input.Length && input[colon] == ':' && end > i)
                {
                    output.Append('"').Append(input, i, end - i).Append('"');
                    i = end - 1; continue;
                }
            }
            output.Append(c);
        }
        if (inString || stack.Count > 0) throw new JsonException("Truncated ES3 text");
        return Encoding.UTF8.GetBytes(output.ToString());
    }
}

public sealed class Es3SaveParser : IEs3SaveParser
{
    private sealed record PriceRow(int Id, FieldValue Price, FieldValue Discount);

    public SaveSnapshot Parse(string text, DateTimeOffset saveWriteTimeUtc, IGameDataProvider gameData)
    {
        byte[] normalized = Es3JsonAdapter.Normalize(text);
        var reader = new Utf8JsonReader(normalized, new JsonReaderOptions { MaxDepth = 128 });
        if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) throw new JsonException("ES3 root must be an object");
        JsonDocument? price = null, progression = null;
        try
        {
            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName) throw new JsonException("Invalid ES3 root");
                string name = reader.GetString()!;
                if (!reader.Read()) throw new JsonException("Truncated ES3 root");
                if (name == "Price") price = JsonDocument.ParseValue(ref reader);
                else if (name == "Progression") progression = JsonDocument.ParseValue(ref reader);
                else reader.Skip(); // Unknown game state never enters our model.
            }
            if (reader.TokenType != JsonTokenType.EndObject || reader.Read()) throw new JsonException("Trailing or truncated ES3 data");
            if (price is null || progression is null) throw new JsonException("Required Price/Progression section missing");
            var p = ValueObject(price.RootElement);
            var g = ValueObject(progression.RootElement);
            var supplier = ReadRows(p, "PricingDatas", true);
            if (supplier.Count == 0) throw new JsonException("PricingDatas missing or empty");
            var player = ReadRows(p, "PricesSetByPlayer", false);
            var average = ReadRows(p, "AverageCosts", false);
            var licenseProducts = ReadLicenseProductState(g);
            var warnings = new List<string>();
            var gameVersion = StringOrNull(g, "GameVersion");
            if (gameVersion != "v1.6.0(223)") warnings.Add($"Unverified game version: {gameVersion ?? "missing"}; verify field semantics before tracker import");
            if (player.Count < supplier.Count) warnings.Add($"Player sell prices present for {player.Count}/{supplier.Count} products; absent values are null");
            if (average.Count < supplier.Count) warnings.Add($"AverageCosts present for {average.Count}/{supplier.Count} products; not a box purchase price");
            int invalidSupplier = supplier.Values.Count(row => row.Price.Status == "invalid");
            if (invalidSupplier > 0) warnings.Add($"{invalidSupplier} supplier price fields could not be parsed; values are null");
            var products = supplier.Values.OrderBy(x => x.Id).Select(row =>
            {
                var pricing = gameData.FindPricing(row.Id);
                bool trusted = pricing is not null && pricing.AssetName == gameData.Find(row.Id)?.AssetName;
                var box = trusted && row.Price.Value is decimal cost
                    ? FieldValue.Derived(cost * pricing!.PurchaseQuantity,
                        $"derived:Price.value.PricingDatas[{row.Id}].Price*ProductSO[{row.Id}].PurchaseQuantity",
                        "supplierUnitPrice", "gameData.purchaseQuantity") : FieldValue.Absent;
                var market = trusted && row.Price.Value is decimal unitCost
                    ? FieldValue.Derived((decimal)Math.Round((double)((float)unitCost +
                        (float)unitCost * (float)pricing!.OptimumProfitRate / 100f), 2, MidpointRounding.ToEven),
                        $"derived:Pricing[{row.Id}].MarketPrice",
                        "supplierUnitPrice", "gameData.optimumProfitRate") : FieldValue.Absent;
                var quantity = trusted ? FieldValue.Present(pricing!.PurchaseQuantity,
                    $"game-data:ProductSO[{row.Id}].PurchaseQuantity") : FieldValue.Absent;
                return new ProductSnapshot(row.Id, quantity, row.Price, box, market,
                    player.GetValueOrDefault(row.Id)?.Price ?? FieldValue.Absent,
                    average.GetValueOrDefault(row.Id)?.Price ?? FieldValue.Absent,
                    row.Discount, FieldValue.Absent, FieldValue.Absent,
                    gameData.Find(row.Id), ActiveProductStatus(row.Id, gameData.Find(row.Id), licenseProducts));
            }).ToArray();
            return new SaveSnapshot(BuildInfo.ApiSchemaVersion, gameVersion, saveWriteTimeUtc,
                DateTimeOffset.UtcNow, Array.AsReadOnly(products),
                Array.AsReadOnly(IntArray(g, "UnlockedLicenses")),
                Array.AsReadOnly(IntArray(g, "ActiveLicenses")), Array.AsReadOnly(warnings.ToArray()));
        }
        finally { price?.Dispose(); progression?.Dispose(); }
    }

    private static JsonElement ValueObject(JsonElement section)
    {
        if (section.ValueKind != JsonValueKind.Object || !section.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Object)
            throw new JsonException("ES3 section has no object value");
        return value;
    }

    private static Dictionary<int, PriceRow> ReadRows(JsonElement section, string name, bool required)
    {
        var result = new Dictionary<int, PriceRow>();
        if (!section.TryGetProperty(name, out var array))
        {
            if (required) throw new JsonException($"{name} missing");
            return result;
        }
        if (array.ValueKind != JsonValueKind.Array) throw new JsonException($"{name} is not an array");
        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("ProductID", out var idValue)
                || !idValue.TryGetInt32(out int id) || id <= 0)
                throw new JsonException($"Invalid ProductID in {name}");
            var price = ReadNumber(item, "Price", $"Price.value.{name}[{id}].Price");
            var discount = ReadNumber(item, "DiscountRate", $"Price.value.{name}[{id}].DiscountRate");
            if (!result.TryAdd(id, new(id, price, discount))) throw new JsonException($"Duplicate ProductID {id} in {name}");
        }
        return result;
    }

    private static FieldValue ReadNumber(JsonElement obj, string name, string source)
    {
        if (!obj.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return FieldValue.Absent;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out decimal number)) return FieldValue.Present(number, source);
        return FieldValue.Invalid(source);
    }

    private static string? StringOrNull(JsonElement obj, string name) => obj.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int[] IntArray(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var array)) return Array.Empty<int>();
        if (array.ValueKind != JsonValueKind.Array) throw new JsonException($"{name} is not an array");
        return array.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.Number && x.TryGetInt32(out int n)
            ? n : throw new JsonException($"Invalid license in {name}")).ToArray();
    }

    private sealed record LicenseProductState(Dictionary<int, HashSet<int>> DisabledProductIds,
        HashSet<int> InvalidLicenseIds, bool Available, bool Valid);

    private static LicenseProductState ReadLicenseProductState(JsonElement progression)
    {
        if (!progression.TryGetProperty("LicenseProductsDatas", out var licenseProducts))
            return new([], [], false, true);
        if (licenseProducts.ValueKind != JsonValueKind.Array)
            return new([], [], true, false);

        var disabledByLicense = new Dictionary<int, HashSet<int>>();
        var invalidLicenseIds = new HashSet<int>();
        bool valid = true;
        foreach (var licenseData in licenseProducts.EnumerateArray())
        {
            if (licenseData.ValueKind != JsonValueKind.Object ||
                !licenseData.TryGetProperty("LicenseID", out var licenseValue) ||
                !licenseValue.TryGetInt32(out int licenseId) || licenseId < 0)
            {
                valid = false;
                continue;
            }
            if (!licenseData.TryGetProperty("DisabledProductIDs", out var disabledProducts) ||
                disabledProducts.ValueKind != JsonValueKind.Array)
            {
                valid = false;
                invalidLicenseIds.Add(licenseId);
                continue;
            }
            var disabledIds = new HashSet<int>();
            foreach (var disabledValue in disabledProducts.EnumerateArray())
                if (disabledValue.ValueKind == JsonValueKind.Number && disabledValue.TryGetInt32(out int id) && id > 0)
                    disabledIds.Add(id);
                else
                {
                    valid = false;
                    invalidLicenseIds.Add(licenseId);
                }
            if (disabledByLicense.ContainsKey(licenseId))
            {
                valid = false;
                invalidLicenseIds.Add(licenseId);
            }
            else disabledByLicense.Add(licenseId, disabledIds);
        }
        return new(disabledByLicense, invalidLicenseIds, true, valid);
    }

    private static BooleanFieldValue ActiveProductStatus(int productId, GameProduct? gameProduct,
        LicenseProductState licenseProducts)
    {
        const string source = "Progression.value.LicenseProductsDatas[*].DisabledProductIDs";
        if (licenseProducts.DisabledProductIds.Values.Any(ids => ids.Contains(productId)))
            return BooleanFieldValue.Present(false, source);
        if (!licenseProducts.Available) return BooleanFieldValue.Absent;
        var licenseIds = gameProduct?.GameLicenseIds ?? [];
        if (licenseIds.Length == 0) return licenseProducts.Valid
            ? BooleanFieldValue.Absent : BooleanFieldValue.Invalid(source);
        if (licenseIds.Any(licenseProducts.InvalidLicenseIds.Contains) || !licenseProducts.Valid)
            return BooleanFieldValue.Invalid(source);
        if (licenseIds.All(licenseProducts.DisabledProductIds.ContainsKey))
            return BooleanFieldValue.Present(true, source);
        return BooleanFieldValue.Absent;
    }
}
