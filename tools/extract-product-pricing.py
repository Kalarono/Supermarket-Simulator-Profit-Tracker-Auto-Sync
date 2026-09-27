"""Read-only extraction of current ProductSO pricing fields into a versioned sidecar.

Requires UnityPy. The asset and save are never opened for writing. The serial field
sequence is checked against the IL2CPP ProductSO layout for game v1.6.0(223).
"""
import argparse
import json
import struct
from pathlib import Path

import UnityPy


def clean(value):
    return round(float(value), 8)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("asset", type=Path)
    parser.add_argument("--metadata", type=Path, default=Path("data/product-metadata.json"))
    parser.add_argument("--output", type=Path, default=Path("data/product-pricing.json"))
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))["products"]
    objects = {obj.path_id: obj for obj in UnityPy.load(str(args.asset)).objects}
    result = []
    for item in metadata:
        if item.get("assetFile") != args.asset.name or item.get("scriptType") not in ("ProductSO", "WeightedProductSO"):
            continue
        raw = objects[item["pathId"]].get_raw_data()
        name = item["assetName"].encode("utf-8")
        if name not in raw[:120]:
            raise ValueError(f"Asset name mismatch: {item['productId']}")
        candidates = []
        # Serialized ProductAmountOnPurchase, BasePrice, MinDynamicPrice,
        # MaxDynamicPrice, OptimumProfitRate and MaxProfitRate are consecutive.
        for offset in range(48, min(len(raw) - 24, 300), 4):
            units, base, low, high, optimum, maximum = struct.unpack_from("<ifffff", raw, offset)
            if (1 <= units <= 1000 and .01 <= base <= 1000 and 0 <= low <= 1000
                    and 0 < high <= 1000 and 1 <= optimum <= 500 and optimum <= maximum <= 1000):
                candidates.append((offset, units, base, optimum))
        if len(candidates) != 1:
            raise ValueError(f"Ambiguous ProductSO pricing for {item['productId']}: {candidates}")
        offset, units, base, optimum = candidates[0]
        weight = None
        if item["scriptType"] == "WeightedProductSO":
            # Inherited ProductSO fields have the same layout; Weight follows
            # the fixed serialized grid/transform fields at +268 bytes.
            weight = struct.unpack_from("<f", raw, offset + 268)[0]
            if not .001 <= weight <= 100:
                raise ValueError(f"Invalid product weight for {item['productId']}")
        quantity = clean(units * weight) if weight is not None else units
        result.append(dict(productId=item["productId"], assetName=item["assetName"],
                           scriptType=item["scriptType"], productAmountOnPurchase=units,
                           weightPerItem=clean(weight) if weight is not None else None,
                           purchaseQuantity=quantity, quantityUnit="kg" if weight is not None else "item",
                           basePrice=clean(base), optimumProfitRate=clean(optimum)))
    if len(result) < 300 or len({x["productId"] for x in result}) != len(result):
        raise ValueError("Incomplete or duplicate ProductSO pricing extraction")
    payload = {"schemaVersion": 1, "gameVersion": "v1.6.0(223)",
               "source": "sharedassets2.assets ProductSO/WeightedProductSO read-only extraction",
               "products": sorted(result, key=lambda x: x["productId"])}
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Extracted {len(result)} products to {args.output}")


if __name__ == "__main__":
    main()
