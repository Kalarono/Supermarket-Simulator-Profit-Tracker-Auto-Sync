using System.Text.Json.Serialization;

namespace SupermarketTrackerSync;

public sealed record FieldValue(decimal? Value, string Status, string? Source)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string[]? DerivedFrom { get; init; }
    public static FieldValue Present(decimal value, string source) => new(value, "present", source);
    public static FieldValue Derived(decimal value, string source, params string[] derivedFrom) =>
        new(value, "present", source) { DerivedFrom = derivedFrom };
    public static FieldValue Absent => new(null, "absent", null);
    public static FieldValue Invalid(string source) => new(null, "invalid", source);
}

public sealed record BooleanFieldValue(bool? Value, string Status, string? Source)
{
    public static BooleanFieldValue Present(bool value, string source) => new(value, "present", source);
    public static BooleanFieldValue Absent => new(null, "absent", null);
    public static BooleanFieldValue Invalid(string source) => new(null, "invalid", source);
}

public sealed record GameProduct(int ProductId, string AssetName, string? TrackerKey, string MappingStatus)
{
    public string Source { get; init; } = "game-assets";
    public string? AuditStatus { get; init; }
    public string? Reason { get; init; }
    public string? Confidence { get; init; }
    public string? Category { get; init; }
    public string? Brand { get; init; }
    public string? License { get; init; }
    public string? Dlc { get; init; }
    public string? ProductType { get; init; }
    public int[] GameLicenseIds { get; init; } = [];
    public string[] TrackerCandidates { get; init; } = [];
    public System.Text.Json.JsonElement? Metadata { get; init; }
}

public sealed record ProductSnapshot(
    int ProductId, FieldValue PurchaseQuantity,
    FieldValue SupplierUnitPrice, FieldValue SupplierBoxPrice,
    FieldValue MarketPrice, FieldValue PlayerSellPrice,
    FieldValue AverageCost, FieldValue DiscountRate,
    FieldValue OnlineBuyPrice, FieldValue PickupBuyPrice,
    GameProduct? GameData, BooleanFieldValue ActiveInProductList);

public sealed record GamePricingData(int ProductId, string AssetName, string ScriptType,
    decimal PurchaseQuantity, string QuantityUnit, decimal OptimumProfitRate);

public sealed record SaveSnapshot(
    int SchemaVersion, string? GameVersion, DateTimeOffset SaveWriteTimeUtc,
    DateTimeOffset ParsedAtUtc, IReadOnlyList<ProductSnapshot> Products,
    IReadOnlyList<int> UnlockedLicenses, IReadOnlyList<int> ActiveLicenses,
    IReadOnlyList<string> Warnings)
{
    public string? SourceSave { get; init; }
    public string? SnapshotHash { get; init; }
}

public sealed record SaveCandidate(string Name, [property: JsonIgnore] string FullPath, long Length,
    DateTimeOffset LastWriteTimeUtc, bool IsActiveSlot, bool IsBackup);

public sealed record SaveSelection(string Directory, SaveCandidate? Selected,
    IReadOnlyList<SaveCandidate> Slots, string Reason);

public sealed record HelperStatus(
    int SchemaVersion, string HelperVersion, bool Connected, bool SaveDirectoryFound,
    string? SelectedSave, string SelectionReason, IReadOnlyList<SaveCandidate> SaveSlots,
    string? GameVersion, DateTimeOffset? LastSaveWriteTime,
    DateTimeOffset? LastAttempt, DateTimeOffset? LastSuccessfulParse,
    int ProductCount, IReadOnlyList<string> Warnings, string? Error)
{
    public string? SnapshotHash { get; init; }
    public string TrackerVersion { get; init; } = BuildInfo.TrackerVersion;
    public string MappingDataVersion { get; init; } = BuildInfo.MappingDataVersion;
}

public interface IEs3SaveParser
{
    SaveSnapshot Parse(string text, DateTimeOffset saveWriteTimeUtc, IGameDataProvider gameData);
}

public interface IGameDataProvider
{
    GameProduct? Find(int productId);
    GamePricingData? FindPricing(int productId) => null;
}
