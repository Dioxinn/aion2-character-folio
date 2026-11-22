/* Public Global armory. Only a player's search or refresh invokes these endpoints. */
(() => {
  "use strict";
  const official = "https://aion2.plaync.com/api/character/";
  const imageHosts = new Set(["assets.playnccdn.com","profileimg.plaync.com","profileimg.plaync.co.kr"]);
  function image(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && imageHosts.has(url.hostname) && !url.username && !url.password && !url.port ? url.href : "";
    } catch { return ""; }
  }
  function requireFields(row,fields) {
    if (!row || fields.some(key=>row[key] == null)) throw new Error("The armory returned an incomplete record.");
  }
  async function get(route,params,signal) {
    const response = await fetch("/nc/"+route+"?"+new URLSearchParams(params),{signal,cache:"no-store",credentials:"omit"});
    if (!response.ok) throw new Error(response.status === 429 ? "The armory is busy. Try again shortly." : "The Global armory could not be reached (HTTP "+response.status+").");
    return response.json();
  }
  function eligible(item,added,slot) {
    if (item.subStatRandom === false) return [false,"The armory marks these lines as fixed."];
    if (slot.startsWith("Arcana")) return [false,"Arcana skills use crafting and enchanting."];
    if (added === false && item.subStatRandom && ["Unique","Heroic","Epic"].includes(item.grade) &&
        item.soulBindRate != null && Number(item.soulBindRate)>=0 && Number(item.soulBindRate)<100)
      return [true,"Standard random Soul Binding line."];
    return [null,"Sync eligibility is unconfirmed for this line."];
  }
  function itemParams(row) {
    requireFields(row,["id","slotPos","enchantLevel","exceedLevel"]);
    return {id:row.id,slotPos:row.slotPos,enchantLevel:row.enchantLevel,exceedLevel:row.exceedLevel};
  }
  function normalize(row,item,common) {
    requireFields(row,["name","grade","slotPosName"]);
    requireFields(item,["level","subStatRandom","subStatCount","enchantLevel","id","name","grade"]);
    if (["name","id","grade","enchantLevel"].some(key=>item[key]!==row[key]))
      throw new Error("The equipment changed during refresh. Try again.");
    const lines=[], ids=new Set();
    for (const [field,kind,valueKey] of [["subStats","stat","value"],["subSkills","skill","level"]]) {
      for (const [sourceIndex,line] of (item[field] ?? []).entries()) {
        requireFields(line,["name","id",valueKey]);
        const id=kind+":"+line.id;
        if (ids.has(id)) throw new Error("The armory returned duplicate effect identifiers.");
        ids.add(id);
        const [rerollable,eligibilityNote]=eligible(item,line.added,row.slotPosName);
        lines.push({id,position:lines.length+1,sourceIndex,kind,statId:line.id,stat:line.name,
          value:(kind==="skill"?"+":"")+line[valueKey],added:line.added,rerollable,eligibilityNote});
      }
    }
    if (item.subStatRandom && lines.length<item.subStatCount) throw new Error("The armory returned incomplete imprint lines.");
    const fields=["mainStats","surpassStats","magicStoneSlotCount","magicStoneStat","godStoneSlotCount","godStoneStat","surpassable","maxExceedEnchantLevel"];
    return {id:row.slotPos+":"+row.id,itemId:row.id,slotId:row.slotPos,slot:row.slotPosName,name:row.name,
      grade:row.grade,level:item.level,category:item.categoryName,enchantLevel:row.enchantLevel,exceedLevel:row.exceedLevel,
      subStatRandom:item.subStatRandom,subStatCount:item.subStatCount,subSkillCountMax:item.subSkillCountMax,
      soulBindRate:item.soulBindRate,icon:image(row.icon),lines,
      sourceUrl:official+"equipment/item?"+new URLSearchParams({...common,...itemParams(row)}),
      armoryDetails:Object.fromEntries(fields.filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]]))};
  }
  async function gear(params,signal) {
    const {region,serverId,characterId}=params;
    const common={region,serverId,characterId,lang:"en-US"};
    const profile=(await get("info",common,signal)).profile;
    requireFields(profile,["characterId","serverId","characterName","serverName","characterLevel","className"]);
    if (profile.characterId!==characterId || String(profile.serverId)!==String(serverId)) throw new Error("Character identity changed.");
    async function getList() {
      const data=(await get("equipment",common,signal)).equipment?.equipmentList;
      if (!Array.isArray(data) || data.length>100 || new Set(data.map(row=>row.slotPos)).size!==data.length)
        throw new Error("The armory returned an invalid equipment list.");
      return data;
    }
    const rows=await getList(), items=[];
    for (const row of rows) {
      await new Promise(resolve=>setTimeout(resolve,350));
      const detail=await get("item",{...common,...itemParams(row)},signal);
      items.push(normalize(row,detail,common));
    }
    const stamp=list=>JSON.stringify(list.map(itemParams).sort((a,b)=>a.slotPos-b.slotPos));
    if (stamp(rows)!==stamp(await getList())) throw new Error("Equipment changed during refresh. Try again.");
    return {snapshot:{schemaVersion:1,source:"NCSOFT Global armory",retrievedAt:new Date().toISOString(),
      sourceUrl:official+"info?"+new URLSearchParams(common),character:{region,serverId:profile.serverId,characterId,
        name:profile.characterName,server:profile.serverName,level:profile.characterLevel,className:profile.className,race:profile.raceName,
        legion:profile.regionName,combatPower:profile.combatPower,profileImage:image(profile.profileImage)},items}};
  }
  async function request(path,params,signal) {
    if (path==="./api/gear") return gear(params,signal);
    if (path!=="./api/characters") throw new Error("Unknown armory operation.");
    const data=await get("search",{keyword:params.name,region:params.region,localeInfo:"en-US",size:20,page:params.page},signal);
    if (!Array.isArray(data.list)) throw new Error("The armory returned an invalid search result.");
    const matches=data.list.filter(row=>row.region===params.region).map(row=>{
      requireFields(row,["characterId","serverId","serverName","name"]);
      const name=row.name.replace(/<\/?strong>/gi,"").replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g,
        token=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[token]));
      return {characterId:decodeURIComponent(row.characterId),serverId:String(row.serverId),server:row.serverName,region:row.region,name};
    });
    return {matches,hasMore:params.page<Number(data.pagination?.endPage || params.page)};
  }
  window.FolioArmory={image,request};
})();
