"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"), path=require("node:path");
const {chromium}=require("playwright");
const origin="https://folio.invalid", web=path.join(__dirname,"..","web");
const player={characterId:"fixture-person",serverId:998,characterName:"FixtureOne",serverName:"Test Server",characterLevel:40,className:"Cleric"};
const worn={id:210530114,slotPos:7,slotPosName:"Gloves",enchantLevel:5,exceedLevel:1,name:"Test Gauntlets",grade:"Unique"};
const detail={...worn,level:70,subStatRandom:true,subStatCount:3,subSkillCountMax:2,soulBindRate:30,
  subStats:[["MP","MP"],["Block","Block"],["MagicAccuracy","Accuracy"]].map(([id,name])=>({id,name,added:false,value:1})),
  subSkills:[],mainStats:[{name:"Defense",value:30}],magicStoneSlotCount:1,magicStoneStat:[],surpassable:true,maxExceedEnchantLevel:5};
async function test() {
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try {
    const context=await browser.newContext(), requests=[], errors=[];
    let fail=false;
    await context.route("**/*",async route=>{
      const url=new URL(route.request().url());
      assert.equal(url.origin,origin);
      if(url.pathname.startsWith("/nc/")){
        requests.push(url.pathname);
        const fixtures={"/nc/search":{list:[{...player,region:"nae",name:"<strong>Fixture</strong>One"}],pagination:{endPage:1}},
          "/nc/info":{profile:player},"/nc/equipment":{equipment:{equipmentList:[worn]}},"/nc/item":detail};
        return route.fulfill({status:fail?502:200,json:fixtures[url.pathname]});
      }
      const file=url.pathname==="/ui/data.js"?path.join(__dirname,"..","build","data.js"):path.join(web,url.pathname==="/"?"index.html":url.pathname);
      const types={".html":"text/html",".css":"text/css",".js":"text/javascript",".ttf":"font/ttf"};
      return fs.existsSync(file)?route.fulfill({path:file,contentType:types[path.extname(file)]}):route.fulfill({status:404});
    });
    const page=await context.newPage();page.setDefaultTimeout(6000);page.on("pageerror",e=>errors.push(e.message));
    await page.goto(origin);
    await page.locator("#find-name").waitFor();
    assert.equal(await page.locator("#find-name").inputValue(),"");
    assert.equal(await page.locator("#quick-character option").count(),1);
    assert.equal(await page.locator("#upload,#sample-gear").count(),0);
    assert.equal(await page.evaluate(()=>localStorage.length),0);
    assert.equal(await page.evaluate(()=>typeof window.AION_PLANNER_DATA),"undefined");
    assert.deepEqual(requests,[]);
    await page.locator("#find-name").fill("Fixture");await page.locator("#character-search button").click();
    await page.getByRole("button",{name:/FixtureOne/}).click();
    await page.locator('.gear-btn[data-slot="Gloves"]').click();
    await page.locator("#inspect-toggle").click();
    assert.deepEqual(requests,["/nc/search","/nc/info","/nc/equipment","/nc/item","/nc/equipment"]);
    assert.equal(await page.locator("#suggestion-ranking").inputValue(),"consensus");
    assert.ok((await page.locator("#suggestion-summary").innerText()).match(/[\d.]+%/));
    const calc=page.locator("#apply-suggestion");
    if(await calc.isEnabled()) await calc.click();
    assert.ok(parseFloat(await page.locator("#acceptable-chance").innerText())>0);
    await page.locator("#suggestion-ranking").selectOption("kisk");
    await page.waitForFunction(()=>document.querySelector("#rail-ranking").value==="kisk");
    await page.locator("#open-upgrade").click();assert.ok(await page.locator("#upgrade-steps button").count());
    await page.locator("#open-guide").click();assert.equal(await page.locator("#guide-class option").count(),9);
    await page.reload();await page.locator('.gear-btn[data-slot="Gloves"]').waitFor();
    assert.equal(requests.length,5);
    fail=true;await page.locator("#refresh").click();
    await page.waitForFunction(()=>document.querySelector("#feedback").textContent.includes("Refresh failed"));
    assert.equal(await page.locator("#character-name").textContent(),"FixtureOne");
    assert.deepEqual(errors,[]);
    console.log("PASS desktop interface: empty start, no armory traffic until search, no import/demo, synthetic NC search and gear response, item details, usable odds, model switch, upgrade path, nine classes, reload and failed refresh.");
  } finally {await browser.close();}
}
test().catch(e=>{console.error(e);process.exitCode=1;});
