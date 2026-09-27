"""Synthetic, read-only mapping logic regressions. Never uses a real game/save."""
import contextlib, csv, importlib.util, io, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('mapping',Path(__file__).parents[1]/'tools/build-mapping-audit.py')
mapping=importlib.util.module_from_spec(spec);spec.loader.exec_module(mapping)

def product(pid,category,brand='Brand',kind='ProductSO',name=None):
    return dict(productId=pid,assetName=name or f'{pid}_{category}_{brand}',category=category,
        brand=brand,scriptType=kind,source='synthetic asset fixture',assetFile='fixture.assets',pathId=pid,
        gameLicenses=[dict(id=21,assetName='Product License 1',pathId=100,arrayOffset=80)])

class MappingTests(unittest.TestCase):
    def generate(self, extra=None, overrides=None, duplicate=False):
        with tempfile.TemporaryDirectory(prefix='smtracker-mapping-tests-') as folder:
            root=Path(folder)
            products=[product(1,'Milk'),product(2,'Bread'),extra or product(3,'Cereal')]
            rows=[dict(License='0',Category=cat,Brand='Brand',IsWeightBased='false',DLC='') for cat in ['Milk','Bread','Cereal']]
            if duplicate: rows.append(dict(rows[-1]))
            with (root/'tracker.csv').open('w',newline='',encoding='utf-8') as f:
                w=csv.DictWriter(f,fieldnames=rows[0].keys());w.writeheader();w.writerows(rows)
            (root/'slot.es3').write_text(json.dumps({'PricingDatas':[{'ProductID':p['productId']} for p in products]}))
            (root/'product-map-overrides.json').write_text(json.dumps(overrides or []))
            args=SimpleNamespace(csv=root/'tracker.csv',save=root/'slot.es3',output=root)
            with contextlib.redirect_stdout(io.StringIO()): mapping.generate_mapping(args,dict(products=products,scanned=[]))
            return json.loads((root/'mapping-audit.json').read_text())

    def test_exact_metadata_requires_corroborated_license(self):
        result=self.generate();self.assertEqual(result['summary']['confirmed'],3)
        self.assertEqual(len(result['licenseCrosswalk']['Product License 1']['witnesses']),3)
    def test_normalization_not_fuzzy_confirmation(self):
        result=self.generate(product(3,'Cereel'))
        self.assertEqual(result['gameProducts'][-1]['auditStatus'],'ambiguous')
        self.assertIsNone(result['gameProducts'][-1]['trackerKey'])
    def test_alias_requires_evidence(self):
        p=product(3,'Cereel')
        with self.assertRaisesRegex(ValueError,'without evidence'):
            self.generate(p,[dict(productId=3,assetName=p['assetName'],trackerKey='Cereal - Brand')])
    def test_reviewed_alias_corroborates_license(self):
        p=product(3,'Cereel')
        out=self.generate(p,[dict(productId=3,assetName=p['assetName'],trackerKey='Cereal - Brand',reason='Fixture spelling alias',source='Fixture asset')])
        self.assertEqual(out['gameProducts'][-1]['auditStatus'],'confirmed-alias')
    def test_duplicate_candidate_stays_ambiguous(self):
        out=self.generate(duplicate=True);self.assertEqual(out['gameProducts'][-1]['auditStatus'],'ambiguous')
    def test_bakery_baked_and_tracker_only(self):
        out=self.generate(product(3,'Cereal',name='3_Cereal_Baked'))
        self.assertEqual(out['gameProducts'][-1]['auditStatus'],'bakery-baked')
        self.assertEqual(out['summary']['trackerOnly'],1)

if __name__=='__main__': unittest.main(verbosity=2)
