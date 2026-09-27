"""Read-only Unity asset audit. Generated sidecars are written only under --output.

Requires UnityPy 1.24.2. No game/save writer is used. Product script types are
resolved through MonoScript metadata, including WeightedProductSO (not names).
"""
import argparse, csv, json, re, struct, hashlib, unicodedata
from pathlib import Path
from collections import Counter, defaultdict
import UnityPy

def norm(s):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD',s.lower().replace('ı','i')))

def tracker_license(p):
    if 'trackerLicenses' in p: return set(p['trackerLicenses'])
    result = set()
    for lic in p['gameLicenses']:
        name = lic['assetName']
        if name == 'Product License_IceCream': result.add('DLC-IceCream-1'); continue
        match = re.fullmatch(r'Product License (\d+)(.*)', name)
        if not match: continue
        num, suffix = int(match[1]), match[2].strip()
        groups = [('Cloth', 'Clothing'),('Electronics','Electronics'),('Hardware','Hardware'),('Mix','Essentials'),('Bakery License','Bakery')]
        if not suffix: result.add(str(num-1)); continue
        for game, tracker in groups:
            if suffix.startswith(game+' '): result.add(f'DLC-{tracker}-{suffix.split()[-1]}')
    return result

def classify_type(p):
    if p['scriptType']=='WeightedProductSO': return 'weighted-produce'
    if p['assetName'].endswith('_Baked'): return 'bakery-baked'
    if p['assetName'].endswith('_Raw'): return 'bakery-raw'
    licenses=tracker_license(p)
    return next((v.split('-')[1] for v in licenses if v.startswith('DLC-')), 'standard')

def generate_mapping(args, metadata):
    with args.csv.open(encoding='utf-8-sig',newline='') as stream:
        rows=list(csv.DictReader(line for line in stream if line.strip() and not line.startswith('#')))
    for row in rows: row['key']=row['Category'] if row['Brand'] in ('','-') else row['Category']+' - '+row['Brand']
    evidence=defaultdict(list)
    for p in metadata['products']:
        matches=[r for r in rows if norm(r['Category'])==norm(p['category']) and norm('' if r['Brand']=='-' else r['Brand'])==norm(p['brand'])]
        if len(matches)==1:
            for lic in p['gameLicenses']:
                evidence[lic['assetName']].append(dict(productId=p['productId'],trackerKey=matches[0]['key'],trackerLicense=matches[0]['License']))
    crosswalk={}
    for name, witnesses in evidence.items():
        values={w['trackerLicense'] for w in witnesses}
        if len(witnesses)>=2 and len(values)==1:
            crosswalk[name]=dict(trackerLicense=next(iter(values)),witnesses=witnesses)
    for p in metadata['products']:
        # Base game asset license numbers are not tracker numbers (produce licenses
        # are interleaved in the tracker). Corroborate the crosswalk from >=2 exact
        # category+brand witnesses; never equate numeric IDs by position.
        found=set()
        for lic in p['gameLicenses']:
            if lic['assetName'] in crosswalk: found.add(crosswalk[lic['assetName']]['trackerLicense'])
            elif re.search(r'Cloth|Electronics|Hardware|Mix|Bakery|IceCream',lic['assetName']): found.update(tracker_license(p))
        p['trackerLicenses']=sorted(found)
    overrides=json.loads((args.output/'product-map-overrides.json').read_text(encoding='utf-8'))
    if len({o['productId'] for o in overrides}) != len(overrides): raise ValueError('Duplicate override ProductID')
    overrides={o['productId']:o for o in overrides}
    save_ids={r['ProductID'] for r in save_rows(args.save)}
    mappings=[]; used={}; unresolved=[]
    for p in metadata['products']:
        pid=p['productId']; licenses=tracker_license(p); product_type=classify_type(p)
        row=None; status='unknown'; reason='No corroborated candidate'; candidates=[]
        if product_type=='bakery-baked':
            status='bakery-baked'; reason='Baked output has a distinct ProductID; tracker represents frozen/raw input only.'
        else:
            # Normalization finds candidates. Independent license reference and product type
            # must also match before confirmation; no nearest-name/fuzzy scoring is used.
            candidates=[r for r in rows if norm(r['Category'])==norm(p['category']) and
                norm('' if r['Brand']=='-' else r['Brand'])==norm(p['brand']) and
                r['License'] in licenses and (r['IsWeightBased']=='true')==(p['scriptType']=='WeightedProductSO')]
            if pid in overrides:
                ov=overrides[pid]
                if ov['assetName']!=p['assetName']: raise ValueError(f'Stale override: {pid}')
                matches=[r for r in rows if r['key']==ov['trackerKey'] and r['License'] in licenses]
                if len(matches)!=1: raise ValueError(f'Override license/key mismatch {pid}')
                if not ov.get('reason') or not ov.get('source'): raise ValueError(f'Override without evidence {pid}')
                row=matches[0]; status='confirmed-alias'; reason=ov['reason']; candidates=matches
            elif len(candidates)==1:
                row=candidates[0]
                exact=row['Category'].strip().casefold()==p['category'].strip().casefold() and ('' if row['Brand']=='-' else row['Brand']).strip().casefold()==p['brand'].strip().casefold()
                status='confirmed-exact' if exact else 'confirmed-metadata'
                reason='Serialized category and brand agree; ProductLicenseSO references this ProductID in the matching tracker license; weighted/standard type agrees.'
            elif len(candidates)>1:
                status='ambiguous'; reason='More than one category/brand/license candidate.'
            else:
                candidates=[r for r in rows if r['License'] in licenses and
                    (norm(r['Category'])==norm(p['category']) or (p['brand'] and norm(r['Brand'])==norm(p['brand'])))]
                if candidates: status='ambiguous'; reason='Category or brand differs; candidate requires explicit reviewed alias.'
                elif pid not in save_ids and not p['gameLicenses']:
                    status='tracker-missing'; reason='Asset exists, but no current license references it and it is absent from this save/catalog; not proven deprecated.'
                else: status='tracker-missing'; reason='No tracker row for this asset and license.'
        if row:
            if row['key'] in used: raise ValueError(f'Duplicate active tracker mapping {row["key"]}')
            used[row['key']]=pid
        entry=dict(productId=pid,assetName=p['assetName'],trackerKey=row['key'] if row else None,
            mappingStatus='mapped' if row else 'unmapped',auditStatus=status,reason=reason,
            confidence='confirmed' if row or status=='bakery-baked' else 'unconfirmed',
            category=p['category'],brand=p['brand'],license=row['License'] if row else None,
            dlc=(row['DLC'] or None) if row else next((v.split('-')[1] for v in licenses if v.startswith('DLC-')),None),
            productType=product_type,gameLicenseIds=[l['id'] for l in p['gameLicenses']],
            trackerCandidates=[r['key'] for r in candidates],metadata=p,source=p['source'])
        mappings.append(entry)
        if not row and status!='bakery-baked': unresolved.append(entry)
    by_id={p['productId']:p for p in mappings}
    missing=save_ids-by_id.keys()
    for pid in sorted(missing):
        mappings.append(dict(productId=pid,assetName='',trackerKey=None,mappingStatus='unmapped',auditStatus='game-asset-missing',reason='No ProductSO or WeightedProductSO found in scanned assets',confidence='unknown',source='asset scan'))
    tracker_rows=[]
    for row in rows:
        conflicts=[p for p in mappings if row['key'] in p.get('trackerCandidates',[]) and not p['trackerKey']]
        pid=used.get(row['key'])
        tracker_rows.append(dict(trackerKey=row['key'],category=row['Category'],brand=row['Brand'],license=row['License'],dlc=row['DLC'] or None,
            productId=pid,status='mapped' if pid else ('ambiguous' if conflicts else 'no matching current game product'),
            reason='Confirmed asset identity' if pid else ('Unresolved category/brand conflict' if conflicts else 'No current asset identity proven; no claim of uninstalled DLC/deprecation')))
    active=[p for p in mappings if p['productId'] in save_ids]
    audit=dict(schemaVersion=1,sourceSave='reference-save',gameProducts=active,trackerProducts=tracker_rows,
        assetsOutsideSave=[p for p in mappings if p['productId'] not in save_ids],
        summary=dict(gameProducts=len(active),trackerProducts=len(rows),confirmed=sum(p['mappingStatus']=='mapped' for p in active),
            statuses=dict(Counter(p['auditStatus'] for p in active)),trackerOnly=sum(p['productId'] is None for p in tracker_rows)),
        missingProductSO=sorted(missing),scan=metadata['scanned'],licenseCrosswalk=crosswalk)
    for filename,data in [('product-map.json',mappings),('mapping-audit.json',audit)]:
        (args.output/filename).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('MAPPING',json.dumps(audit['summary']))
    print('UNRESOLVED',json.dumps([dict(id=p['productId'],name=p['assetName'],category=p['category'],brand=p['brand'],candidates=p['trackerCandidates']) for p in unresolved]))

def aligned_string(raw, offset):
    n = struct.unpack_from('<i', raw, offset)[0]
    if n < 0 or n > 512 or offset+4+n > len(raw): raise ValueError('Invalid string')
    return raw[offset+4:offset+4+n].decode('utf-8'), (offset+4+n+3)&~3

def read_header(obj):
    raw = obj.get_raw_data()
    if len(raw) < 36: return None
    try: name, offset = aligned_string(raw, 28)
    except (ValueError, UnicodeError, struct.error): return None
    return raw, name, offset, struct.unpack_from('<iq', raw, 16)

def save_rows(path):
    text = path.read_text(encoding='utf-8-sig')
    start = text.index('[', text.index('"PricingDatas"'))
    return json.JSONDecoder().raw_decode(text[start:])[0]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game-data', type=Path, required=True)
    ap.add_argument('--save', type=Path, required=True)
    ap.add_argument('--output', type=Path, default=Path('data'))
    ap.add_argument('--csv', type=Path, default=Path('supermarket-tracker-template.csv'))
    ap.add_argument('--extract-only', action='store_true')
    ap.add_argument('--use-metadata', action='store_true')
    args = ap.parse_args()
    if args.use_metadata:
        generate_mapping(args,json.loads((args.output/'product-metadata.json').read_text(encoding='utf-8')))
        return
    scripts = {}
    script_asset = UnityPy.load(str(args.game_data/'globalgamemanagers.assets'))
    for obj in script_asset.objects:
        if obj.type.name == 'MonoScript': scripts[obj.path_id] = obj.read_typetree()['m_ClassName']
    products, licenses, scanned = {}, [], []
    # Scan all serialized asset/scene files and addressable bundles, not just sharedassets2.
    files = sorted(p for p in args.game_data.iterdir() if p.is_file() and
        (p.suffix == '.assets' or re.fullmatch(r'level\d+',p.name)))
    files += sorted((args.game_data/'StreamingAssets').rglob('*.bundle'))
    for file in files:
        env = UnityPy.load(str(file))
        count = 0
        for obj in env.objects:
            if obj.type.name != 'MonoBehaviour': continue
            header = read_header(obj)
            if not header: continue
            raw, name, offset, (fid, sid) = header
            # FileID refers to the specific MonoScript external, not a global guessed number.
            externals = obj.assets_file.externals
            external = externals[fid-1].path if 0 < fid <= len(externals) else ''
            cls = scripts.get(sid) if external.lower().endswith('globalgamemanagers.assets') else None
            if cls == 'ProductLicenseSO':
                licenses.append((file.name, obj.path_id, name, struct.unpack_from('<i', raw, offset)[0], raw, offset))
            if cls not in ('ProductSO', 'WeightedProductSO'): continue
            pid = struct.unpack_from('<i',raw,offset)[0]
            if not re.match(rf'^{pid}_',name): raise ValueError(f'ProductID/name disagreement: {name}')
            category, cursor = aligned_string(raw,offset+4)
            guid, cursor = aligned_string(raw,cursor)
            if not guid.startswith('GUID:'): raise ValueError('Unknown ProductSO localization layout')
            # LocalizedString after its table name: keyId(8), key(4 empty), fallback(4),
            # waitForCompletion(4 aligned), localVariables count(4). Checked across all rows.
            brand, end_brand = aligned_string(raw,cursor+24)
            if any(raw[cursor+8:cursor+24]): raise ValueError('Unsupported non-empty localization options')
            meta = dict(productId=pid, assetName=name, assetFile=file.name, pathId=obj.path_id,
                scriptType=cls, category=category, brand=brand,
                source='MonoScript class + serialized ProductID/category/brand + ProductLicenseSO PPtr',
                gameLicenses=[])
            if pid in products and products[pid]['assetName'] != name: raise ValueError(f'Duplicate asset ID {pid}')
            products[pid] = meta
            count += 1
        scanned.append(dict(file=file.name, productObjects=count))
    # License PPtr arrays validated against resolved objects within the same asset file.
    refs = {(p['assetFile'],p['pathId']):p for p in products.values()}
    for file, path_id, name, license_id, raw, offset in licenses:
        arrays = []
        for pos in range(offset+4,len(raw)-16,4):
            n = struct.unpack_from('<i',raw,pos)[0]
            if not 1 <= n <= 80 or pos+4+n*12 > len(raw): continue
            ptrs = [struct.unpack_from('<iq',raw,pos+4+j*12) for j in range(n)]
            if all(fid == 0 and (file,pid) in refs for fid,pid in ptrs): arrays.append((n,ptrs,pos))
        if not arrays: continue
        n, ptrs, pos = max(arrays,key=lambda a:a[0])
        for _, pid in ptrs:
            refs[file,pid]['gameLicenses'].append(dict(id=license_id,assetName=name,pathId=path_id,arrayOffset=pos))
    args.output.mkdir(parents=True,exist_ok=True)
    metadata = dict(schemaVersion=1, scanned=scanned, productCount=len(products),
        products=sorted(products.values(),key=lambda p:p['productId']))
    (args.output/'product-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(products=len(products),types=Counter(p['scriptType'] for p in products.values()),
        noLicense=[p['productId'] for p in products.values() if not p['gameLicenses']],scanned=scanned),indent=2))
    if not args.extract_only: generate_mapping(args,metadata)

if __name__ == '__main__': main()
