// Read-only HTTP/route-security integration checks against a running helper.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const port=Number(process.env.TRACKER_TEST_PORT||47831);
const root=path.join(__dirname,'..');
let passed=0,failed=0;
function request(urlPath,method='GET',headers={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:urlPath,method,headers},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
      res.on('end',()=>resolve({code:res.statusCode,body,headers:res.headers}));
    });req.setTimeout(3000,()=>req.destroy(new Error('timeout')));req.on('error',reject);req.end();
  });
}
async function check(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
(async()=>{
  await check('root serves canonical HTML bytes',async()=>{
    const r=await request('/');assert.equal(r.code,200);
    assert.equal(r.body,fs.readFileSync(path.join(root,'supermarketSimulator-tracker_v2_9.html'),'utf8'));
  });
  await check('tracker route serves same canonical page',async()=>assert.equal((await request('/tracker')).body,(await request('/')).body));
  await check('only embedded adapter is served',async()=>{
    const r=await request('/src/game-sync.js');assert.equal(r.code,200);
    assert.equal(r.body,fs.readFileSync(path.join(root,'src/game-sync.js'),'utf8'));
    assert.match(r.headers['content-type'],/javascript/);
  });
  await check('optional localization client is served as an embedded resource',async()=>{
    const r=await request('/src/game-localization.js');assert.equal(r.code,200);
    assert.equal(r.body,fs.readFileSync(path.join(root,'src/game-localization.js'),'utf8'));
    assert.match(r.headers['content-type'],/javascript/);
  });
  await check('UI localization scripts are served as embedded resources',async()=>{
    for(const file of ['ui-messages.js','ui-localization.js']){
      const r=await request('/src/'+file);assert.equal(r.code,200);
      assert.equal(r.body,fs.readFileSync(path.join(root,'src',file),'utf8'));
      assert.match(r.headers['content-type'],/javascript/);
    }
  });
  await check('profit threshold client is served as an embedded resource',async()=>{
    const r=await request('/src/profit-threshold.js');assert.equal(r.code,200);
    assert.equal(r.body,fs.readFileSync(path.join(root,'src/profit-threshold.js'),'utf8'));
    assert.match(r.headers['content-type'],/javascript/);
  });
  await check('installed game localization exposes detected languages and bundle fingerprint',async()=>{
    const r=await request('/locales');assert.equal(r.code,200);
    const data=JSON.parse(r.body);assert.equal(data.schemaVersion,1);assert.ok(data.available.includes('en')&&data.available.includes('ru-RU'));
    const bundled=JSON.parse(fs.readFileSync(path.join(root,'data/game-localization.json'),'utf8'));
    assert.equal(data.steamBuildId,bundled.game.steamBuildId);assert.match(data.bundleFingerprint,/^sha256:/);
  });
  await check('official Russian product label maps by ProductID and keeps brand canonical',async()=>{
    const r=await request('/localization/ru-RU');assert.equal(r.code,200);
    const data=JSON.parse(r.body),p=data.products['33'];assert.equal(data.available,true);assert.equal(data.locale,'ru-RU');
    assert.equal(p.productId,33);assert.equal(p.canonicalCategory,'Cereal');assert.equal(p.canonicalBrand,'Chokipik');
    assert.equal(p.localizedCategory,'Хлопья');assert.equal(p.localizedBrand,null);assert.equal(p.displayName,'Хлопья - Chokipik');
    assert.ok(r.body.includes('Хлопья'));
  });
  await check('unsupported language returns explicit English fallback without translated records',async()=>{
    const r=await request('/localization/fr-FR');assert.equal(r.code,200);
    const data=JSON.parse(r.body);assert.equal(data.available,false);assert.equal(data.locale,'en');
    assert.equal(data.fallbackLocale,'en');assert.equal(data.source,'canonical-fallback');assert.deepEqual(data.products,{});
  });
  await check('mapping audit download has complete two-way catalog',async()=>{
    const r=await request('/mapping-audit');assert.equal(r.code,200);
    const a=JSON.parse(r.body);assert.equal(a.gameProducts.length,309);assert.equal(a.trackerProducts.length,294);
  });
  await check('published helper includes built-in mapping without sidecar',async()=>{
    const r=await request('/products');assert.equal(r.code,200);
    const p=JSON.parse(r.body).products;assert.equal(p.filter(p=>p.gameData?.mappingStatus==='mapped').length,292);
    assert.equal(p.find(p=>p.productId===165).gameData.metadata.scriptType,'WeightedProductSO');
  });
  await check('traversal and arbitrary filesystem paths denied',async()=>{
    for(const p of ['/../Program.cs','/%2e%2e/Program.cs','/src/../../data/product-map.json','/C:/Windows/win.ini','/logs/helper.log','/data/product-map.json','/supermarket-tracker-template.csv'])
      assert.notEqual((await request(p)).code,200,p);
  });
  await check('POST PUT DELETE and HEAD rejected',async()=>{
    for(const method of ['POST','PUT','DELETE','HEAD'])assert.equal((await request('/products',method)).code,405,method);
  });
  await check('DNS rebinding Host rejected',async()=>assert.equal((await request('/status','GET',{Host:`example.com:${port}`})).code,403));
  await check('foreign and opaque origins rejected by default',async()=>{
    for(const Origin of ['https://example.com','null'])assert.equal((await request('/products','GET',{Origin})).code,403);
  });
  await check('same-origin request allowed',async()=>assert.equal((await request('/products','GET',{Origin:`http://127.0.0.1:${port}`})).code,200));
  await check('API remains live read-only schema 3 with cache protection',async()=>{
    const r=await request('/status'),s=JSON.parse(r.body);assert.equal(s.schemaVersion,3);assert.equal(s.connected,true);assert.equal(s.productCount,309);
    assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff');
  });
  console.log(`RESULT ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
})();
