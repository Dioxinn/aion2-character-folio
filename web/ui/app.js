/* The report runs from a file. Only an explicit gear refresh contacts the local server. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const own = (obj, key) => obj != null && Object.hasOwn(obj, key);
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const clean = value => typeof value === "string" ? value.trim() : "";
  const byName = name => {
    const key = clean(name).replace(/[‘’]/g, "'").replace(/\s+/g," ").toLowerCase();
    return key === "status effect accuracy" ? "status effect chance" : key;
  };
  const fm = new Intl.NumberFormat(undefined, {maximumFractionDigits: 3});
  const list = new Intl.ListFormat("en",{type:"conjunction",style:"long"});
  const rate = value => value > 0 && value < 0.00000001 ? "<0.000001%" : fm.format(value * 100) + "%";
  const chance = value => value == null ? "—" : (value * 100).toFixed(2) + "%";
  const localModels = new WeakSet();

  let bundle, selectedId, imported = false, gearRequest = null;
  let searchRevision = 0, nextSearchPage = 1;
  const liveMode = ["http:","https:"].includes(location.protocol);
  const regionNames = Object.fromEntries([...$("find-region").options].map(o => [o.value,o.textContent]));
  let states = new Map();
  function node(tag, value, cls) {
    const el = document.createElement(tag);
    if (value !== undefined && value !== null) el.textContent = value;
    if (cls) el.className = cls;
    return el;
  }
  function option(value, text) {
    const el = node("option", text);
    el.value = value;
    return el;
  }
  function href(text) {
    try {
      const url = new URL(text);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }
  function link(text, url) {
    const target = href(url);
    if (!target) return node("span", text);
    const a = node("a", text);
    a.href = target;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    return a;
  }
  let feedbackTimer;
  function feedback(message, autoDismiss = false) {
    clearTimeout(feedbackTimer);
    $("feedback").hidden = !message;
    $("feedback").textContent = message;
    if (autoDismiss) feedbackTimer = setTimeout(() => feedback(""),5000);
  }
  function unique(names) {
    const result = new Map();
    for (const name of names.map(clean).filter(Boolean)) {
      if (!result.has(byName(name))) result.set(byName(name), name);
    }
    return [...result.values()];
  }
  function validate(raw) {
    const envelope = raw?.snapshot ? raw : {snapshot:raw};
    const snapshot = envelope.snapshot;
    if (!record(snapshot?.character) || !clean(snapshot.character.name) || !Array.isArray(snapshot.items)) {
      throw new Error("A snapshot must include character.name and an items array.");
    }
    const region = [snapshot.character.region, snapshot.region, snapshot.edition].join(" ");
    if (/\b(KR|TW|Korea|Taiwan)\b/i.test(region)) throw new Error("Choose an AION 2 Global snapshot.");
    const seen = new Set();
    const items = snapshot.items.map((item, i) => {
      if (!record(item) || !clean(item.name) || !Array.isArray(item.lines)) {
        throw new Error("An equipped item is missing its name or lines array.");
      }
      const id = String(item.id ?? item.slotId ?? item.itemId ?? i);
      if (seen.has(id)) throw new Error("Each equipped slot needs a unique ID.");
      seen.add(id);
      const lineIds = new Set();
      const lines = item.lines.map((line, j) => {
        if (!record(line) || !clean(line.stat)) throw new Error("A line is missing its stat name.");
        const lineId = String(line.id ?? line.position ?? j + 1);
        if (lineIds.has(lineId)) throw new Error("Each line within an item needs a unique ID.");
        lineIds.add(lineId);
        return {...line, id:lineId, position:line.position ?? j + 1};
      });
      return {...item, id, lines};
    });
    for (const prop of ["rules","alternateRules","catalog","benchmarks","observations","observationNotes"]) {
      if (envelope[prop] != null && !record(envelope[prop])) throw new Error("Invalid " + prop + " in this data file.");
    }
    for (const collection of [envelope.rules,envelope.alternateRules]) {
      for (const rule of Object.values(collection ?? {})) {
        if (!record(rule?.byLine)) throw new Error("An item probability model needs a per-line table.");
        if (rule.assumedSelectableLineIds != null && !Array.isArray(rule.assumedSelectableLineIds)) {
          throw new Error("The probability model contains invalid selectable-line IDs.");
        }
        for (const table of Object.values(rule.byLine)) {
          if (!record(table) || !Array.isArray(table.outcomes) || table.outcomes.some(outcome=>!record(outcome))) {
            throw new Error("The model contains an invalid outcome table.");
          }
        }
      }
    }
    return {...envelope, snapshot:{...snapshot,items}};
  }
  const item = () => bundle.snapshot.items.find(gear => gear.id === selectedId);
  const state = () => states.get(selectedId);
  function entry(collection, current = item()) {
    if (!current || !collection) return null;
    for (const id of [current.id, current.itemId]) {
      if (id != null && own(collection, id)) return collection[id];
    }
    return null;
  }
  function targetCatalog(gear = item()) {
    const rawCatalog = entry(bundle.catalog,gear);
    const names = Array.isArray(rawCatalog) ? rawCatalog.map(x => typeof x === "string" ? x : x?.stat) : [];
    if (!Array.isArray(rawCatalog)) {
      for (const rules of [entry(bundle.rules,gear), entry(bundle.alternateRules,gear)]) {
        for (const table of Object.values(rules?.byLine ?? {})) {
          for (const outcome of table.outcomes) names.push(outcome.stat);
        }
      }
      for (const row of Object.values(entry(bundle.observations,gear) ?? {})) {
        for (const [name, value] of Object.entries(row ?? {})) if (value > 0) names.push(name);
      }
    }
    return unique(names);
  }
  function defaultLine(gear,trends) {
    const candidates = gear.lines.filter(line => line.rerollable !== false);
    const usage = new Map(trends.map(row => [byName(row.name),row.usage]));
    const unlisted = candidates.filter(line => !usage.has(byName(line.stat)));
    return unlisted[0] ||
      candidates.slice().sort((a,b) => usage.get(byName(a.stat)) - usage.get(byName(b.stat)))[0];
  }
  const armorSlots = ["MainHand","SubHand","Helmet","Shoulder","Torso","Pants","Gloves","Boots","Cape","Belt"];
  const accessorySlots = ["Necklace","Amulet","Earring1","Earring2","Ring1","Ring2","Bracelet1","Bracelet2","Rune1","Rune2"];
  const slotLabels = {MainHand:"Main hand",SubHand:"Off hand",Helmet:"Head",Shoulder:"Shoulders",Torso:"Chest",Pants:"Legs"};
  const gearButtons = new Map();
  let railMode = "none", returnScroll = 0, boardScroll = 0;
  function slotLabel(gear) {
    return slotLabels[gear.slot] || (gear.slot || "Equipment").replace(/(\D)(\d+)$/, "$1 $2");
  }
  function artFrame(url,fallback,cls) {
    const frame = node("span",fallback,cls);
    frame.setAttribute("aria-hidden","true");
    const source = window.FolioArmory.image(url);
    if (!source) return frame;
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.onerror = () => img.remove();
    img.src = source;
    frame.append(img);
    return frame;
  }
  function gearIcon(gear) {
    return artFrame(gear.icon,slotLabel(gear).slice(0,2).toUpperCase(),"gear-icon");
  }
  let legacyGearResponse = false;
  const restartHelp = "The armory returned incomplete item details. Try refreshing gear again.";
  function breakthroughIndicator(gear,compact = false) {
    const level = gear.exceedLevel;
    if (!Number.isInteger(level) || level < 0) return null;
    const detail = gear.armoryDetails;
    const maximum = detail?.maxExceedEnchantLevel;
    const eligible = detail?.surpassable;
    if (eligible === false || (!level && !maximum && !eligible)) return null;
    const knownMaximum = Number.isInteger(maximum) && maximum > 0 && maximum >= level;
    const value = knownMaximum ? level + "/" + maximum : "+" + level;
    const total = knownMaximum ? maximum : level;
    if (compact) {
      const stars = total > 0 && total <= 10 ? "★".repeat(level) + "☆".repeat(total-level) :
        (level > 0 ? "★ " : "☆ ") + (knownMaximum ? value : level);
      const mark = node("span",stars,"board-breakthrough");
      mark.title = "Breakthrough " + (knownMaximum ? level + " of " + maximum : level);
      mark.setAttribute("role","img");
      mark.setAttribute("aria-label",mark.title);
      return mark;
    }
    const row = node("div",null,"breakthrough-level");
    row.append(node("span","Breakthrough"));
    if (total > 0 && total <= 20) {
      const marks = node("span","◆".repeat(level) + "◇".repeat(total-level),"diamonds");
      marks.setAttribute("aria-hidden","true");
      row.append(marks);
    }
    row.append(node("span",value,"breakthrough-value"));
    return row;
  }
  function equippedStats(gear) {
    if (!gear.lines.length) return node("p","No equipped effect lines reported.","card-note");
    const stats = node("dl",null,"equipped-stats");
    for (const line of gear.lines)
      stats.append(node("dt",line.stat),node("dd",lineValue(line) || "—"));
    return stats;
  }
  function armoryCard(gear, hover = false) {
    const card = node("div",null,"armory-card");
    const data = gear.armoryDetails;
    function section(label,contents,count = "") {
      const group = node(hover ? "section" : "details",null,"armory-section");
      const heading = node(hover ? "h4" : "summary",label);
      if (count) heading.append(node("small",count));
      if (!hover) group.open = true;
      group.append(heading,contents);
      card.append(group);
    }
    const imprint = gear.slot?.startsWith("Arcana") ? "Equipped skills" : "Soul imprint";
    const extraLines = gear.lines.filter(line=>line.added === true).length;
    section(imprint,equippedStats(gear),gear.lines.length + (extraLines ? " · " + extraLines + " extra" : ""));
    if (!record(data)) {
      card.append(node("p",legacyGearResponse ? restartHelp : liveMode ? "Refresh gear to load main stats and sockets." :
        "Open the live planner and refresh gear to load main stats and sockets.","card-note"));
      return card;
    }
    function statList(rows) {
      const stats = node("dl",null,"equipped-stats main-stats");
      for (const row of rows) {
        if (!record(row) || !row.name || row.value == null) continue;
        const hasRange = row.minValue != null && row.minValue !== "" && row.minValue !== row.value;
        const value = node("dd",hasRange ? row.minValue + " – " + row.value : row.value);
        const extra = String(row.extra ?? "").trim();
        if (extra && !/^[+-]?0(?:\.0+)?%?$/.test(extra)) {
          const bonus = node("small",/^[+−-]/.test(extra) ? extra : "+" + extra,"stat-bonus");
          bonus.title = "Enhancement contribution";
          value.append(" ",bonus);
        }
        stats.append(node("dt",row.name),value);
      }
      return stats;
    }
    if (Array.isArray(data.mainStats) && data.mainStats.length) section("Main stats",statList(data.mainStats));
    if (Array.isArray(data.surpassStats) && data.surpassStats.length) section("Breakthrough stats",statList(data.surpassStats));
    for (const [label,countKey,rowsKey] of [
      ["Manastones","magicStoneSlotCount","magicStoneStat"],["Theostones","godStoneSlotCount","godStoneStat"]
    ]) {
      const rows = data[rowsKey], capacity = data[countKey];
      const haveRows = Array.isArray(rows);
      const stones = haveRows ? rows.filter(row=>record(row) && row.name) : [];
      if (!stones.length && !(capacity > 0)) continue;
      const contents = node("ul",null,"socket-list");
      for (const stone of stones.slice().sort((a,b)=>a.slotPos-b.slotPos)) {
        const entry = node("li");
        const grade = clean(stone.grade).toLowerCase();
        const symbol = node("span",null,"socket-symbol");
        symbol.dataset.grade = grade;
        const name = node("span",stone.name);
        if (grade) {
          const gradeName = grade === "legend" ? "Epic" : grade === "epic" ? "Heroic" : stone.grade;
          name.title = symbol.title = gradeName;
          symbol.setAttribute("role","img");
          symbol.setAttribute("aria-label",gradeName + " grade");
        } else symbol.setAttribute("aria-hidden","true");
        entry.append(symbol,name,node("span",stone.value,"socket-value"));
        if (stone.desc) entry.append(node("small",stone.desc,"socket-description"));
        contents.append(entry);
      }
      if (!haveRows) contents.append(node("li","Socket contents unreported","socket-empty"));
      else if (capacity > stones.length) {
        const empty = capacity - stones.length;
        contents.append(node("li",empty === 1 ? "1 empty socket" : empty + " empty sockets","socket-empty"));
      }
      section(label,contents,haveRows ? stones.length + (Number.isInteger(capacity) ? "/" + capacity : "") : "");
    }
    return card;
  }
  const gearTip = $("gear-tooltip");
  let tipAnchor = null;
  function hideGearTip() {
    tipAnchor?.removeAttribute("aria-describedby");
    tipAnchor = null;
    gearTip.hidden = true;
  }
  function positionGearTip() {
    if (!tipAnchor) return;
    const rect = tipAnchor.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    if (!tipAnchor.isConnected || !rect.width || rect.bottom <= 0 || rect.top >= height) {
      hideGearTip();
      return;
    }
    const tipWidth = gearTip.offsetWidth, margin = 6;
    let left = rect.left, top = rect.top;
    if (rect.right + tipWidth + margin <= width || rect.left >= tipWidth + margin) {
      left = rect.right + tipWidth + margin <= width ? rect.right : rect.left - tipWidth;
      gearTip.style.maxHeight = "";
    } else {
      const below = height - rect.bottom - margin, above = rect.top - margin;
      const useBelow = below >= above;
      gearTip.style.maxHeight = Math.max(0,useBelow ? below : above) + "px";
      top = useBelow ? rect.bottom : rect.top - gearTip.offsetHeight;
    }
    gearTip.style.left = Math.max(margin,Math.min(left,width - tipWidth - margin)) + "px";
    gearTip.style.top = Math.max(margin,Math.min(top,height - gearTip.offsetHeight - margin)) + "px";
  }
  function showGearTip(button,gear) {
    if (tipAnchor === button) return;
    hideGearTip();
    const head = node("div",null,"tooltip-head");
    const text = node("div");
    text.append(node("strong",gear.name),node("small",[gear.grade,slotLabel(gear),
      gear.level != null ? "Item level " + gear.level : "", gear.enchantLevel != null ? "Enchant +" + gear.enchantLevel : ""].filter(Boolean).join(" · ")));
    const breakthrough = breakthroughIndicator(gear);
    if (breakthrough) text.append(breakthrough);
    head.append(gearIcon(gear),text);
    gearTip.replaceChildren(head,armoryCard(gear,true));
    gearTip.scrollTop = 0;
    tipAnchor = button;
    gearTip.hidden = false;
    button.setAttribute("aria-describedby",gearTip.id);
    positionGearTip();
  }
  gearTip.onpointerleave = event => {
    if (!tipAnchor?.contains(event.relatedTarget)) hideGearTip();
  };
  window.addEventListener("resize",positionGearTip);
  window.addEventListener("scroll",positionGearTip,{passive:true});
  function buttonFor(gear) {
    const btn = node("button",null,"gear-btn");
    const label = node("span",null,"gear-label");
    const meta = node("small",slotLabel(gear));
    const enchant = node("span",gear.enchantLevel != null ? "+" + gear.enchantLevel : "","board-enchant");
    const stars = breakthroughIndicator(gear,true);
    if (stars) enchant.append(enchant.textContent ? " " : "",stars);
    if (enchant.textContent) meta.append(" · ",enchant);
    label.append(node("strong",gear.name),meta);
    btn.type = "button";
    btn.dataset.slot = gear.slot || "";
    btn.setAttribute("aria-controls","rail-details");
    btn.append(gearIcon(gear),label);
    btn.onpointerenter = event => { if (event.pointerType !== "touch") showGearTip(btn,gear); };
    btn.onpointerleave = event => {
      if (tipAnchor === btn && !gearTip.contains(event.relatedTarget)) hideGearTip();
    };
    btn.onfocus = () => { if (btn.matches(":focus-visible")) showGearTip(btn,gear); };
    btn.onblur = () => { if (tipAnchor === btn) hideGearTip(); };
    btn.onclick = () => {
      hideGearTip();
      upgradePreview = null;
      boardScroll = window.scrollY;
      $("editor-back").hidden = true;
      selectGear(gear);
      drawRail("item");
      if (matchMedia("(max-width:1199px)").matches)
        ($("editor").hidden ? $("detail-title") : $("inspect-toggle")).focus();
    };
    gearButtons.set(gear.id,btn);
    return btn;
  }
  function renderBoard() {
    hideGearTip();
    const {character:ch,items} = bundle.snapshot;
    const focusedId = [...gearButtons].find(([,btn]) => btn === document.activeElement)?.[0];
    const key = profileKey(profileIdentity(bundle.snapshot));
    const initials = ch.name.trim().split(/\s+/).slice(0,2).map(w=>Array.from(w)[0]).join("").toUpperCase();
    $("portrait").replaceChildren(artFrame(ch.profileImage || ch.classIcon,initials,"portrait-image"));
    $("character-name").textContent = $("menu-name").textContent = ch.name;
    $("menu-server").textContent = [ch.server,regionNames[ch.region] || ch.region].filter(Boolean).join(" · ");
    $("identity-faction").textContent = [ch.race,ch.legion].filter(Boolean).join(" · ");
    $("identity-cp").textContent = ch.combatPower == null ? "Unknown" : fm.format(ch.combatPower);
    const facts = $("identity-facts");
    facts.replaceChildren();
    for (const [label,value] of [["Level",ch.level],["Class",ch.className],["Server",ch.server],
      ["Region",regionNames[ch.region] || ch.region]]) {
      facts.append(node("dt",label),node("dd",value ?? "Unknown"));
    }
    gearButtons.clear();
    const cards = items.filter(g=>/^Arcana\d*$/i.test(g.slot)).sort((a,b)=>a.slot.localeCompare(b.slot,undefined,{numeric:true}));
    const extra = items.filter(g=>!armorSlots.includes(g.slot) && !accessorySlots.includes(g.slot) && !cards.includes(g));
    const bank = slots=>slots.flatMap(slot=>items.filter(g=>g.slot === slot));
    for (const [id,members] of [["armor",bank(armorSlots)],["accessory",bank(accessorySlots)],["arcana",cards],["extra",extra]])
      $(id + "-slots").replaceChildren(...members.map(buttonFor));
    $("extra-bank").hidden = !extra.length;
    $("arcana-bank").hidden = !cards.length;
    $("gear-list").classList.toggle("no-gear",!items.length);
    $("empty").hidden = Boolean(items.length);
    $("count").textContent = (items.length - cards.length) + " equipped / " + cards.length + " Arcana";
    if (focusedId) gearButtons.get(focusedId)?.focus({preventScroll:true});
  }
  function selectGear(gear) {
    if (gear.id !== selectedId) pinDraft = null;
    selectedId = gear.id;
    if (!states.has(gear.id)) states.set(gear.id,{lineId:defaultLine(gear,slotTrends(gear))?.id,targets:[]});
  }
  function drawRail(mode) {
    const gear = item();
    railMode = mode === "item" && gear ? "item" : "none";
    const details = $("rail-details"), selected = railMode === "item";
    $("inspection").hidden = !selected;
    $("board-return").hidden = !selected;
    for (const [id,btn] of gearButtons) btn.setAttribute("aria-pressed",String(selected && id === selectedId));
    details.replaceChildren();
    if (!selected) {
      setEditorOpen(false);
      if (bundle.snapshot.items.length) details.append(node("p","Select an equipped item to see its details.","helper"));
      return;
    }
    const title = node("h3",gear.name);
    title.id = "detail-title";
    title.tabIndex = -1;
    const heading = node("div",null,"selected-item-head");
    const identity = node("div");
    identity.append(node("p",[slotLabel(gear),gear.grade].filter(Boolean).join(" · "),"kicker"),title);
    heading.append(gearIcon(gear),identity);
    details.append(heading,
      node("p",[gear.level != null ? "Item level " + gear.level : "",gear.enchantLevel != null ? "Enchant +" + gear.enchantLevel : "",
        gear.soulBindRate != null ? gear.soulBindRate + "% bound" : "Binding unknown"].filter(Boolean).join(" · "),"gear-info"));
    const breakthrough = breakthroughIndicator(gear);
    if (breakthrough) details.append(breakthrough);
    const trends = slotTrends(gear), plan = recommendationPlan(gear,trends), top = plan.top;
    const held = new Set(gear.lines.map(line=>byName(line.stat)));
    if (plan.active || (plan.comparison && plan.custom && top.length)) {
      const count = equippedIdealCount(top,held);
      const ideal = node("p",null,"rail-ideal");
      ideal.append(node("span",plan.comparison ? "Gear goals" : "Ideal Lines","kicker")," ",
        node("span",count + " of " + top.length + " equipped","ideal-total"));
      if (plan.source !== "consensus") ideal.append(node("small",plan.label,"custom-mark"));
      details.append(ideal);
    }
    if (gear.lines.some(line=>line.rerollable !== false) && plan.choices.length) {
      details.append(node("p","Suggested reroll","kicker"));
      const label = node("label","Ranking ","recommendation-ranking");
      const select = node("select");
      select.id = "rail-ranking";
      fillRecommendationMenu(select,slotRankings(gear.slot).entries,plan.requested ?? plan.source);
      select.onchange = chooseRecommendation;
      label.append(select);
      details.append(label);
      if (plan.requested) details.append(node("small","Using Consensus for this item.","card-note"));
    }
    if (plan.active) {
      const {best,reason} = suggestedReroll(gear,top,held,plan.ranked,plan.custom ? "Consensus" : plan.label);
      if (best) {
        const apply = node("button","Recommended Reroll","primary rail-reroll");
        apply.type = "button";
        apply.setAttribute("aria-controls","editor");
        apply.onclick = () => useSuggestion(gear,best,"board");
        const advice = node("p",null,"rail-advice");
        advice.append(node("strong",best.line.stat)," · " + chance(best.row.probability) + " chance to gain a missing ideal line.");
        details.append(advice,apply);
      } else details.append(node("p",reason));
    } else if (gear.lines.some(l=>l.rerollable !== false)) {
      details.append(node("p","A complete set of six eligible ideal lines is unavailable for this item.","card-note"));
    } else {
      const notes = unique(gear.lines.map(l=>l.eligibilityNote || ""));
      details.append(node("p",notes.join(" ") || "This equipment has no selectable Sync lines.","card-note"));
    }
    const stats = armoryCard(gear);
    stats.tabIndex = 0;
    stats.setAttribute("role","region");
    stats.setAttribute("aria-label","Equipped item stats");
    details.append(stats);
    $("inspect-label").textContent = gear.lines.some(line=>line.rerollable !== false) ? "Inspect reroll" : "Inspect item";
    $("item-name").textContent = gear.name;
    $("item-slot").textContent = slotLabel(gear);
    $("item-meta").textContent = [gear.grade, gear.level != null ? "Item level " + gear.level : "",
      gear.enchantLevel != null ? "+" + gear.enchantLevel : ""].filter(Boolean).join(" · ");
    if (!$("editor").hidden) renderItem();
  }
  function setEditorOpen(open) {
    $("editor").hidden = !open;
    $("inspect-toggle").setAttribute("aria-expanded", String(open));
    if (open) renderItem();
    else $("editor-back").hidden = true;
  }
  function backFromEditor() {
    if (!$("editor-back").hidden) {
      showView("upgrade");
      const target = [...$("upgrade-steps").querySelectorAll("button")].find(b=>b.dataset.gearId === selectedId);
      (target || $("open-upgrade")).focus({preventScroll:true});
      window.scrollTo(0,returnScroll);
    } else {
      setEditorOpen(false);
      returnToSlot();
    }
  }
  function returnToSlot() {
    (gearButtons.get(selectedId) || $("open-planner")).focus({preventScroll:true});
    window.scrollTo(0,boardScroll);
  }
  function lineValue(line) {
    const raw = line.displayValue ?? line.value;
    if (raw == null || typeof raw === "object") return "";
    return String(raw);
  }
  function slotIdeals(gear = item()) {
    const reference = classReference()?.ideals;
    const slot = clean(gear.slot).replace(/^(Earring|Ring|Bracelet)[12]$/, "$1");
    return reference && own(reference.slots,slot) ? reference.slots[slot] : [];
  }

  const guideSlotLabels = {MainHand:"Weapons",SubHand:"Guard",Helmet:"Helm",Shoulder:"Pauldrons",Torso:"Top",
    Pants:"Legs",Boots:"Shoes",Cape:"Cloak",Earring:"Earrings"};
  const arcanaTypes = {Arcana1:"Chalice",Arcana2:"Parchment",Arcana3:"Compass",Arcana4:"Bell",Arcana5:"Mirror"};
  function guideSlot(gear = item()) {
    const slot = clean(gear?.slot).replace(/^(Ring|Earring|Bracelet)[12]$/, "$1");
    return guideSlotLabels[slot] ?? slot;
  }

  function className(name = bundle.snapshot.character.className) {
    return ({Elementalist:"Spiritmaster",Fighter:"Brawler"})[name] || name;
  }
  function classReference(name = className()) {
    return window.AION_CLASS_DATA.guides[name];
  }

  function compareUsage(globalRows = [], koreaRows = [], data = classReference()) {
    const matches = new Map();
    for (const [region,rows] of [["global",globalRows],["korea",koreaRows]]) {
      for (const row of rows) {
        const key = byName(row.name);
        if (!matches.has(key)) matches.set(key,{name:row.name});
        matches.get(key)[region] = row;
      }
    }
    for (const pair of matches.values()) {
      const g = pair.global, k = pair.korea;
      if (g && k) {
        pair.used = g.used + k.used;
        pair.sample = (g.sample ?? data.globalGuide.sampleSize) + (k.sample ?? data.buildGuide.sampleSize);
        pair.usage = 100 * pair.used / pair.sample;
      } else pair.usage = (g ?? k).usage;
    }
    // Keep Global-only choices in contention. Unlisted rates are unknown.
    return [...matches.values()].sort((a,b) => Number(Boolean(b.global)) - Number(Boolean(a.global)) ||
      b.usage - a.usage || Number(Boolean(b.korea)) - Number(Boolean(a.korea)));
  }
  const consensusFormat = new Intl.NumberFormat(undefined,{maximumFractionDigits:2});
  const consensusNote = "Average of NotMeter Global, NotMeter KR/TW and Kisk Korea. An unlisted effect counts as 0% for that source.";
  function consensusUsage(globalRows = [], koreaRows = [], kiskRows = []) {
    const matches = new Map();
    for (const [source,rows] of [["global",globalRows],["korea",koreaRows],["kisk",kiskRows]]) {
      for (const row of rows) {
        const name = row.name ?? row.effect, key = byName(name);
        if (!matches.has(key)) matches.set(key,{name});
        const match = matches.get(key);
        if (!match[source] || row.usage > match[source].usage) match[source] = row;
      }
    }
    for (const row of matches.values())
      row.usage = ((row.global?.usage ?? 0) + (row.korea?.usage ?? 0) + (row.kisk?.usage ?? 0)) / 3;
    // A stable sort keeps source order for exact ties, including at the sixth ideal line.
    return [...matches.values()].sort((a,b) => b.usage - a.usage);
  }
  function slotTrends(gear = item()) {
    const data = classReference();
    if (!data) return [];
    const slot = guideSlot(gear), rows = guide => {
      if (arcanaTypes[gear.slot]) return guide?.arcana?.[arcanaTypes[gear.slot]]?.["Most-used attached skills"] ?? [];
      const group = guide?.soul[slot];
      return [...(group?.Options ?? []),...(group?.Skills ?? [])];
    };
    return consensusUsage(rows(data.globalGuide),rows(data.buildGuide),slotIdeals(gear));
  }

  const pinPrefix = "aion2.sync.ideal-rankings.v2.";
  const legacyPinPrefix = "aion2.sync.ideal-pins.v1.";
  let pinDraft = null;
  let builtinView = "consensus";
  const recommendationSources = new Map([...$("ranking-source").options].map(opt=>[opt.value,opt.text]));
  const anonymousSources = new Map();
  let upgradeChoice = "consensus", upgradePreview = null;
  function pinKey(slot) {
    const character = bundle && profileKey(profileIdentity(bundle.snapshot));
    return character && slot ? pinPrefix + JSON.stringify([character,slot]) : "";
  }
  function readRankings(key) {
    const empty = {active:null,entries:[]};
    if (!key) return empty;
    const raw = localStorage.getItem(key);
    if (raw === null) {
      const old = JSON.parse(localStorage.getItem(legacyPinPrefix + key.slice(pinPrefix.length)));
      const pins = Array.isArray(old) ? unique(old).slice(0,6) : [];
      return pins.length ? {active:"custom-legacy",entries:[{id:"custom-legacy",name:"My Ranking",pins}]} : empty;
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.entries) || data.entries.some(entry =>
      !record(entry) || !clean(entry.id).startsWith("custom-") || !clean(entry.name) || !Array.isArray(entry.pins)))
      throw new Error("The saved rankings could not be read.");
    return data;
  }
  function slotRankings(slot) {
    try {
      return readRankings(pinKey(slot));
    } catch { return {active:null,entries:[]}; }
  }
  function activeRanking(slot) {
    const book = slotRankings(slot);
    return book.entries.find(entry=>entry.id === book.active);
  }
  function newRankingId() {
    return "custom-" + Array.from(crypto.getRandomValues(new Uint32Array(4)),v=>v.toString(16).padStart(8,"0")).join("");
  }
  function freeRankingName(base,entries) {
    const taken = new Set(entries.map(entry=>entry.name.toLowerCase()));
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) {
      const suffix = " (" + i + ")";
      name = base.slice(0,48-suffix.length) + suffix;
    }
    return name;
  }
  function nameError(name,entries,id) {
    if (!name || name.length > 48) return "Enter a ranking name of 1 to 48 characters.";
    const normalized = value=>value.toLowerCase().replace(/[^\p{L}\p{N}]/gu,"");
    const builtins = [...$("ranking-source").options].filter(opt=>!opt.value.startsWith("custom-"));
    if (builtins.some(opt=>normalized(opt.text) === normalized(name))) return "Choose a name different from the built-in rankings.";
    if (entries.some(entry=>entry.id !== id && entry.name.toLowerCase() === name.toLowerCase()))
      return "That name is already in use for this slot.";
    return "";
  }
  function otherSlot(slot) {
    const pair = /^(Ring|Earring|Bracelet)([12])$/.exec(slot);
    return pair ? pair[1] + (pair[2] === "1" ? "2" : "1") : "";
  }
  function idealPool(gear) {
    const rule = entry(bundle.rules,gear) ?? entry(bundle.alternateRules,gear);
    const pool = rule?.retryPool;
    const names = [];
    if (pool) {
      for (const [weights,share] of [[pool.statWeights,1 - pool.skillShare],[pool.skillWeights,pool.skillShare]]) {
        if (share > 0) for (const [name,weight] of Object.entries(weights ?? {})) {
          if (weight > 0) names.push(name);
        }
      }
    } else if (Array.isArray(entry(bundle.catalog,gear))) {
      names.push(...targetCatalog(gear));
    }
    return unique(names);
  }
  function sourceRows(source,trends,gear) {
    if (source === "kisk") return slotIdeals(gear).map(row=>({...row,name:row.effect}));
    if (source === "global" || source === "notmeter")
      return trends.map(row=>source === "global" ? row.global : row.korea).filter(Boolean).sort((a,b)=>b.usage-a.usage);
    return trends;
  }

  function fillRecommendationMenu(select,custom,value,acrossSlots = false) {
    const options = [...recommendationSources].map(([id,label])=>option(id,label));
    if (acrossSlots) options.push(option("per-slot","Use each slot’s ranking"));
    if (custom.length) {
      const group = node("optgroup");
      group.label = "Saved rankings";
      group.append(...custom.map(row=>option(row.id,row.name)));
      options.push(group);
    }
    select.replaceChildren(...options);
    select.value = value;
    if (!select.value) select.value = "consensus";
  }

  function recommendationPlan(gear,trends,requested) {
    const book = slotRankings(gear.slot);
    let selected = requested ?? (upgradePreview?.gearId === gear.id ? upgradePreview.source : null);
    if (!selected || selected === "per-slot") selected = book.active || book.source || anonymousSources.get(gear.slot) || "consensus";
    const custom = selected.startsWith("named-") ? book.entries.find(row=>"named-"+row.name.toLowerCase() === selected) :
      book.entries.find(row=>row.id === selected);
    const source = custom ? "consensus" : recommendationSources.has(selected) ? selected : "consensus";
    const plan = idealPlan(gear,trends,custom ?? null,source);
    if (source !== "consensus" && !plan.top.length) return {...idealPlan(gear,trends,null),requested:source};
    return plan;
  }

  function idealPlan(gear,trends,ranking = activeRanking(gear.slot),source = "consensus") {
    const pins = ranking?.pins ?? [];
    const rerollable = gear.subStatRandom !== false && gear.lines.some(line=>line.rerollable !== false);
    const comparison = !rerollable && Boolean(otherSlot(gear.slot)) &&
      (gear.subStatRandom === false || gear.lines.length > 0);
    let choices = rerollable ? idealPool(gear) : [];
    if (comparison) {
      const pair = otherSlot(gear.slot);
      const worn = bundle.snapshot.items.filter(g=>g.slot === gear.slot || g.slot === pair);
      choices = unique([...trends.map(row=>row.name),...worn.flatMap(g=>g.lines.map(line=>line.stat))]);
    }
    const available = new Map(choices.map(name=>[byName(name),name]));
    const usage = new Map(trends.map(row=>[byName(row.name),row.usage]));
    const editableBracelet = rerollable && /^Bracelet[12]$/.test(gear.slot);
    const limit = editableBracelet ? Math.min(6,Math.max(gear.subStatCount || 0,gear.lines.length)) : 6;
    const top = [], unavailable = [], reserves = [], pinned = new Set();
    for (const pin of pins) {
      const key = byName(pin);
      if (available.has(key)) {
        const row = {name:available.get(key),usage:usage.get(key),pinned:true};
        if (top.length < limit) top.push(row);
        else reserves.push({...row,reserve:true});
        pinned.add(key);
      } else unavailable.push(pin);
    }
    const ranked = sourceRows(source,trends,gear);
    const restricted = new Set(trends.filter(row=>row.korea && !row.global).map(row=>byName(row.name)));
    for (const row of ranked) {
      if (top.length >= limit) break;
      const key = byName(row.name);
      const allowed = comparison || (source === "consensus" ? row.global : !restricted.has(key));
      if (allowed && available.has(key) && !pinned.has(key))
        top.push({...row,name:available.get(key)});
    }
    const custom = Boolean(ranking);
    const active = rerollable && (top.length === limit || ((custom || editableBracelet || source !== "consensus") && top.length > 0));
    return {pins,top,choices,unavailable,reserves,custom,ranking,active,comparison,limit,ranked,
      source:ranking?.id ?? source,label:ranking?.name ?? recommendationSources.get(source)};
  }

  function equippedIdealCount(top,held) {
    return top.filter(row => held.has(byName(row.name))).length;
  }

  function refreshPinChoices() {
    if (!pinDraft) return;
    const search = byName($("pin-search").value);
    const pinned = new Set(pinDraft.pins.map(byName));
    const choices = pinDraft.choices.filter(name=>!pinned.has(byName(name)) && byName(name).includes(search));
    $("pin-choice").replaceChildren(...(choices.length ? choices.map(name=>option(name,name)) : [option("","No matching effects")]));
    $("pin-add").disabled = !choices.length || pinned.size >= 6;
    $("pin-choice").disabled = !choices.length;
  }

  function renderPinEditor(saved,trends,editable) {
    const gear = item(), key = pinKey(gear.slot), toggle = $("pin-toggle");
    if (!editable || pinDraft?.key !== key) pinDraft = null;
    toggle.hidden = !editable;
    $("pin-edit").hidden = !editable || !saved.custom;
    toggle.setAttribute("aria-expanded",String(Boolean(pinDraft && !pinDraft.id)));
    $("pin-edit").setAttribute("aria-expanded",String(Boolean(pinDraft?.id)));
    $("pin-editor").hidden = !pinDraft;
    if (!pinDraft) return;
    const pins = pinDraft.pins, preview = idealPlan(gear,trends,pinDraft);
    $("pin-title").textContent = bundle.snapshot.character.name + " · " + slotLabel(gear);
    $("pin-name").value = pinDraft.name;
    $("pin-help").textContent = preview.comparison ? "Fixed gear. Pin effects to compare equipped pieces. Open places follow Consensus." :
      preview.limit < 6 ? "This bracelet has " + preview.limit + " imprint lines. Extra pins stay in reserve. Consensus fills open places." :
        "Pin up to six effects in priority order. Consensus fills the open places.";
    pinDraft.choices = preview.choices.slice().sort((a,b)=>a.localeCompare(b));
    refreshPinChoices();
    const rows = [...preview.top,...preview.reserves];
    for (const name of preview.unavailable) rows.push({name,unavailable:true});
    $("pin-list").replaceChildren();
    const held = new Set(gear.lines.map(line=>byName(line.stat)));
    for (const row of rows) {
      const li = node("li"), text = node("div",null,"pin-effect");
      const index = pins.findIndex(name=>byName(name) === byName(row.name));
      const origin = row.unavailable ? "Unavailable on this item" : row.reserve ? "Reserve" : row.pinned ? "Pinned" : "Consensus";
      const info = [origin];
      if (row.usage != null) info.push(consensusFormat.format(row.usage) + "% usage");
      if (held.has(byName(row.name))) info.push("Equipped");
      text.append(node("strong",row.name),node("small",info.join(" · ")));
      const actions = node("span",null,"pin-row-actions");
      function action(label,verb,disabled=false) {
        const button = node("button",label);
        button.type = "button";
        button.dataset.action = verb;
        button.dataset.name = row.name;
        button.disabled = disabled;
        button.setAttribute("aria-label",verb + " " + row.name);
        actions.append(button);
      }
      if (index === -1) action("Pin","Pin",pins.length >= 6);
      else {
        action("↑","Move up",index === 0);
        action("↓","Move down",index === pins.length-1);
        action("Unpin","Unpin");
      }
      li.append(text,actions);
      $("pin-list").append(li);
    }
    const count = equippedIdealCount(preview.top,held);
    let note = count + " of " + preview.top.length + " equipped.";
    if (preview.active) {
      const {best,reason} = suggestedReroll(gear,preview.top,held,trends);
      note += best ? " Reroll " + best.line.stat + " for a " + chance(best.row.probability) + " chance to gain " +
        new Intl.ListFormat("en",{type:"disjunction"}).format(best.outcomes.map(effect=>effect.name)) + "." : " " + reason;
    }
    $("pin-preview").textContent = note;
    updateRankingActions();
  }
  function updateRankingActions() {
    const gear = item(), entries = slotRankings(gear.slot).entries;
    const original = entries.find(entry=>entry.id === pinDraft.id);
    const dirty = !original || original.name !== pinDraft.name.trim() ||
      JSON.stringify(original.pins) !== JSON.stringify(pinDraft.pins);
    const error = nameError(pinDraft.name.trim(),entries,pinDraft.id);
    $("pin-name-error").textContent = error;
    $("pin-name-error").hidden = !error;
    $("pin-name").setAttribute("aria-invalid",String(Boolean(error)));
    $("pin-save").disabled = Boolean(error) || !dirty;
    $("pin-delete").hidden = !original;
    const other = otherSlot(gear.slot);
    $("pin-copy").hidden = !other;
    if (other) {
      $("pin-copy").textContent = "Copy to " + slotLabel({slot:other});
      $("pin-copy").disabled = dirty || !original;
      $("pin-copy").title = dirty || !original ? "Save this ranking before copying." :
        "Add an independent copy to " + slotLabel({slot:other}) + ".";
    }
    $("pin-cancel").textContent = dirty ? "Discard edits" : "Close";
  }

  function redrawPins() {
    const gear = item(), trends = slotTrends(gear);
    renderPinEditor(idealPlan(gear,trends),trends,true);
  }
  function closePins() {
    pinDraft = null;
    redrawPins();
    ($("pin-edit").hidden ? $("pin-toggle") : $("pin-edit")).focus();
  }
  function openRankingEditor(existing) {
    if (pinDraft && (pinDraft.id ?? null) === (existing?.id ?? null)) return closePins();
    const gear = item();
    pinDraft = {key:pinKey(gear.slot),id:existing?.id ?? null,
      name:existing?.name ?? freeRankingName("My Ranking",slotRankings(gear.slot).entries),
      pins:existing?.pins.slice() ?? [],baseline:JSON.stringify(existing ?? null)};
    $("pin-search").value = $("pin-status").textContent = "";
    redrawPins();
    $("pin-name").focus();
    $("pin-name").select();
  }
  $("pin-toggle").onclick = () => openRankingEditor(null);
  $("pin-edit").onclick = () => openRankingEditor(activeRanking(item().slot));
  $("pin-name").oninput = () => {
    if (!pinDraft) return;
    pinDraft.name = $("pin-name").value;
    $("pin-status").textContent = "";
    updateRankingActions();
  };
  $("pin-cancel").onclick = closePins;
  $("pin-search").oninput = refreshPinChoices;
  $("pin-form").onsubmit = event => {
    event.preventDefault();
    if (!pinDraft || $("pin-add").disabled) return;
    pinDraft.pins.push($("pin-choice").value);
    $("pin-search").value = $("pin-status").textContent = "";
    redrawPins();
    $("pin-search").focus();
  };
  $("pin-list").onclick = event => {
    const button = event.target.closest("button");
    if (!button || !pinDraft || button.disabled) return;
    const {action,name} = button.dataset, pins = pinDraft.pins;
    const index = pins.findIndex(pin=>byName(pin) === byName(name));
    if (action === "Pin") pins.push(name);
    else if (action === "Unpin") pins.splice(index,1);
    else {
      const next = index + (action === "Move up" ? -1 : 1);
      [pins[index],pins[next]] = [pins[next],pins[index]];
    }
    $("pin-status").textContent = "";
    redrawPins();
    const neighbors = [...$("pin-list").querySelectorAll("button:enabled")].filter(b=>b.dataset.name === name);
    (neighbors.find(b=>b.dataset.action === action) || neighbors[0] || $("pin-search")).focus();
  };
  async function writeRankings(key,change) {
    function commit() {
      const book = readRankings(key);
      const result = change(book);
      localStorage.setItem(key,JSON.stringify(book));
      return result ?? true;
    }
    try {
      return navigator.locks ? await navigator.locks.request(key,commit) : commit();
    } catch (error) {
      const message = error instanceof DOMException ? "Could not save rankings in this browser." : error.message;
      if (pinDraft) $("pin-status").textContent = message;
      else feedback(message,true);
      return null;
    }
  }
  $("pin-save").onclick = async () => {
    const draft = pinDraft;
    if (!draft) return;
    const entry = {id:draft.id ?? newRankingId(),name:draft.name.trim(),pins:draft.pins.slice()};
    const result = await writeRankings(draft.key,book=>{
      const error = nameError(entry.name,book.entries,entry.id);
      if (error) throw new Error(error);
      const index = book.entries.findIndex(row=>row.id === entry.id);
      if (draft.id && JSON.stringify(book.entries[index] ?? null) !== draft.baseline)
        throw new Error("This ranking changed in another tab. Reopen it before saving.");
      if (index < 0) book.entries.push(entry);
      else book.entries[index] = entry;
      book.active = entry.id;
    });
    if (!result || pinDraft !== draft) return;
    upgradePreview = null;
    Object.assign(draft,entry,{baseline:JSON.stringify(entry)});
    drawRail("item");
    $("pin-status").textContent = "Saved " + entry.name + " for " + slotLabel(item()) + ".";
  };
  $("pin-copy").onclick = async () => {
    const draft = pinDraft;
    const dest = otherSlot(item().slot);
    if (!dest || !draft?.id) return;
    const source = {name:draft.name.trim(),pins:draft.pins.slice()};
    const copy = await writeRankings(pinKey(dest),book=>{
      let match = book.entries.find(row=>row.name === source.name && JSON.stringify(row.pins) === JSON.stringify(source.pins));
      if (!match) {
        match = {id:newRankingId(),name:freeRankingName(source.name,book.entries),pins:source.pins};
        book.entries.push(match);
      }
      book.active = match.id;
      return match;
    });
    if (copy && pinDraft === draft) $("pin-status").textContent = "Copied to " + slotLabel({slot:dest}) + " as " + copy.name + ".";
  };
  $("pin-delete").onclick = async () => {
    const draft = pinDraft;
    const original = draft?.id && slotRankings(item().slot).entries.find(entry=>entry.id === draft.id);
    if (!original || !window.confirm("Delete “" + original.name + "” from " + slotLabel(item()) + "?")) return;
    const result = await writeRankings(draft.key,book=>{
      const saved = book.entries.find(entry=>entry.id === draft.id);
      if (JSON.stringify(saved ?? null) !== draft.baseline) throw new Error("This ranking changed in another tab. Reopen it before deleting.");
      book.entries = book.entries.filter(entry=>entry.id !== draft.id);
      if (book.active === draft.id) {
        book.active = null;
        book.source = "consensus";
      }
    });
    if (!result || pinDraft !== draft) return;
    pinDraft = null;
    upgradePreview = null;
    builtinView = "consensus";
    drawRail("item");
    $("pin-toggle").focus();
  };
  window.addEventListener("storage",event=>{
    if (!bundle || (event.key !== null && !event.key.startsWith(pinPrefix) && !event.key.startsWith(legacyPinPrefix))) return;
    if (pinDraft?.id && itemIfLoaded() && (event.key === null || event.key === pinDraft.key)) {
      const saved = slotRankings(item().slot).entries.find(row=>row.id === pinDraft.id);
      const previous = JSON.parse(pinDraft.baseline);
      if (saved && previous?.name === pinDraft.name && JSON.stringify(previous.pins) === JSON.stringify(pinDraft.pins)) {
        Object.assign(pinDraft,{name:saved.name,pins:saved.pins.slice(),baseline:JSON.stringify(saved)});
      } else if (JSON.stringify(saved ?? null) !== pinDraft.baseline) {
        $("pin-status").textContent = "This ranking changed in another tab. Your edits are still open.";
      }
    }
    if (!$("upgrade-view").hidden) renderUpgradePath();
    else if (itemIfLoaded() && railMode === "item") drawRail("item");
  });

  const twoColumns = matchMedia("(min-width:768px)"), threeColumns = matchMedia("(min-width:1050px)");
  function layoutReference(container,rows) {
    const odds = container.id === "pool-rows";
    const columns = Math.min(rows.length,(odds && threeColumns.matches) ? 3 : twoColumns.matches ? 2 : 1);
    container.style.setProperty("--columns",String(columns || 1));
    const tables = [], focused = container.contains(document.activeElement) ? document.activeElement : null;
    let offset = 0;
    for (let i = 0; i < columns; i++) {
      const size = Math.ceil((rows.length - offset) / (columns - i));
      const table = node("table");
      table.style.setProperty("--reference-rows",String(size + 1));
      table.setAttribute("aria-label",(odds ? "Item odds" : "Ideal roll rankings") + ", entries " +
        (offset + 1) + " to " + (offset + size));
      const headings = table.createTHead().insertRow();
      for (const label of (odds ? ["Effect","Base chance","This roll"] : ["Effect","Usage","Action"])) {
        const th = node("th",label);
        th.scope = "col";
        headings.append(th);
      }
      table.createTBody().append(...rows.slice(offset,offset + size));
      tables.push(table);
      offset += size;
    }
    container.replaceChildren(...tables);
    if (focused?.isConnected) focused.focus({preventScroll:true});
  }
  function reflowReferences() {
    for (const id of ["ideal-rows","pool-rows"]) {
      const container = $(id);
      layoutReference(container,[...container.querySelectorAll("tbody tr")]);
    }
  }
  twoColumns.addEventListener("change",reflowReferences);
  threeColumns.addEventListener("change",reflowReferences);

  function renderCard(effects, trends, koreaOnly) {
    const current = state(), kisk = slotIdeals();
    const guide = classReference()?.buildGuide;
    const plan = recommendationPlan(item(),trends), top = plan.top;
    const book = slotRankings(item().slot);
    const referencePlan = idealPlan(item(),trends);
    const canCustomize = Boolean(pinKey(item().slot) && (plan.choices.length || book.entries.length) &&
      (plan.comparison || item().lines.some(line=>line.rerollable !== false)));
    const hasRankings = Boolean(trends.length || kisk.length || book.entries.length);
    const ranking = $("ranking-source");
    let group = ranking.querySelector("optgroup");
    if (!group) {
      group = node("optgroup");
      group.label = "Saved rankings";
      ranking.append(group);
    }
    group.replaceChildren(...book.entries.map(entry=>option(entry.id,entry.name)));
    group.hidden = !book.entries.length;
    ranking.querySelector('option[value="kisk"]').disabled = !kisk.length;
    const mode = referencePlan.custom ? "custom" : builtinView === "kisk" && !kisk.length ? "consensus" : builtinView;
    ranking.value = referencePlan.custom ? referencePlan.ranking.id : mode;
    let rows = kisk;
    if (mode === "custom") rows = referencePlan.top;
    else if (mode === "consensus") rows = trends;
    else if (mode !== "kisk") rows = trends.map(pair => mode === "global" ? pair.global : pair.korea)
      .filter(Boolean).sort((a,b) => b.usage - a.usage).map(row => ({effect:row.name,usage:row.usage}));
    const held = new Set(item().lines.map(line => byName(line.stat)));
    const count = $("ideal-count");
    count.textContent = plan.active ? "Ideal Lines " + equippedIdealCount(top,held) + " of " + top.length +
      (plan.source !== "consensus" ? " · " + plan.label : "") : "";
    count.title = plan.active ? (plan.custom ? "Custom priorities: " : plan.source === "consensus" ? "Highest-usage Global-eligible consensus rolls: " : plan.label + ": ") +
      top.map(row => row.name).join(", ") : "";
    $("ideal-names").hidden = !plan.active;
    $("ideal-names-list").textContent = top.map(row=>row.name).join(" · ");
    renderSuggestion(plan,held);
    $("ideal-face").hidden = !hasRankings && !canCustomize;
    renderPinEditor(referencePlan,trends,canCustomize);
    $("ideal-rows").hidden = $("ideal-context").hidden = $("ideal-source").hidden = !hasRankings;
    $("ranking-label").hidden = !trends.length && !book.entries.length;
    if (!hasRankings) return;
    const data = classReference(), reference = data?.ideals;
    const players = className() + " players";
    $("ideal-context").textContent = {consensus:consensusNote,
      custom:"Pinned effects first. Consensus fills the remaining places in usage order.",
      global:"Share of " + (data?.globalGuide?.sampleSize ?? 0) + " Global PvE " + players + " with each effect.",
      notmeter:"Share of " + (guide?.sampleSize ?? 0) + " KR/TW PvE " + players + " with each effect.",
      kisk:"Slot usage among " + (reference?.sampleSize ?? 0) + " Korean PvE " + players +
        " in Kisk’s " + reference?.sampleDate + " sample."}[mode];
    const sources = $("ideal-source");
    if (mode === "kisk") {
      sources.replaceChildren(link("Kisk scoring tables",reference.method));
      if (reference.skillSource && kisk.some(row => row.source === "gearCard"))
        sources.append(" · ",link("Skill lines from Kisk’s gear cards",reference.skillSource));
    } else {
      sources.replaceChildren(...(guide ? [link("NotMeter build guide",guide.source)] : []));
      if ((mode === "consensus" || mode === "custom") && kisk.length) sources.append(" · ",link("Kisk rankings",reference.method));
    }
    const available = new Map(effects.map(effect => [byName(effect.name),effect]));
    const container = $("ideal-rows"), rankingRows = [];
    for (const row of rows) {
      const label = row.effect ?? row.name, key = byName(label), effect = available.get(key);
      const tr = node("tr"), header = node("th",label);
      rankingRows.push(tr);
      header.scope = "row";
      header.tabIndex = -1;
      tr.append(header);
      const usage = tr.insertCell();
      usage.textContent = row.usage == null ? "—" : (mode === "consensus" || mode === "custom" ? consensusFormat : fm).format(row.usage) + "%";
      if (mode === "custom") usage.append(node("small",row.pinned ? "Pinned" : "Consensus","region-note"));
      if (mode === "consensus") {
        const value = source => source ? fm.format(source.usage) + "%" : "unlisted (0%)";
        usage.title = "NotMeter Global: " + value(row.global) + " · NotMeter KR/TW: " + value(row.korea) +
          " · Kisk Korea: " + value(row.kisk);
      }
      const restricted = koreaOnly.has(key);
      const region = restricted ? "KR/TW only" : row.region;
      if (region) usage.append(node("small",region,"region-note"));
      if (row.source === "gearCard") usage.append(node("small","Skill","region-note"));
      const action = tr.insertCell();
      if (held.has(key)) {
        action.append(node("span","Equipped","held-mark"));
      } else if (byName(current.targets[0]) === key) {
        action.append(node("span","Targeted","selected-mark"));
      } else if (effect?.probability > 0 || (restricted && current.lineId)) {
        const name = effect?.name ?? label;
        const added = current.targets.slice(1).some(target => byName(target) === key);
        const actions = node("div",null,"ideal-actions");
        const target = node("button","Target","pick-ideal");
        target.type = "button";
        target.setAttribute("aria-label","Target " + name);
        target.disabled = restricted;
        target.onclick = () => {
          current.targets = unique([name,...current.targets.slice(1)]);
          renderItem();
          $("target").focus();
        };
        const add = node("button",added ? "Added" : "Add","pick-ideal");
        add.type = "button";
        add.setAttribute("aria-label",(added ? "Already added " : "Add ") + name);
        add.disabled = restricted || added;
        add.onclick = () => {
          if (!addAcceptable(name)) return;
          $("other-targets").open = true;
          [...container.querySelectorAll("tbody th")].find(th=>th.textContent === label)?.focus({preventScroll:true});
        };
        actions.append(target,add);
        action.append(actions);
      } else {
        action.textContent = !current.lineId ? "—" : effect?.probability === null ? "Odds unknown" : "Unavailable";
      }
    }
    layoutReference(container,rankingRows);
  }
  function renderItem() {
    const gear = item(), current = state();
    $("line-heading").textContent = current.lineId ? "Line to reroll" : "Equipped effects";
    const effects = current.lineId ? effectsForSelectedLine() : [];
    const trends = slotTrends();
    const pinned = new Set(recommendationPlan(gear,trends).top.filter(row=>row.pinned).map(row=>byName(row.name)));
    const koreaOnly = new Set(trends.filter(pair => pair.korea && !pair.global && !pinned.has(byName(pair.name))).map(pair => byName(pair.name)));
    const eligible = effects.filter(effect => !effect.held && effect.probability !== 0);
    const hasTarget = eligible.some(effect => !koreaOnly.has(byName(effect.name)));
    $("roll-controls").hidden = !current.lineId;
    $("chance-panel").hidden = !hasTarget;
    $("no-lines").hidden = hasTarget;
    $("no-lines").textContent = current.lineId && !effects.length ? "Roll data is unavailable for this item and class." :
      current.lineId ? "No selectable target effects for this line." :
      "This equipment has no selectable Sync lines.";
    $("fixed-lines").hidden = Boolean(current.lineId) || !gear.lines.length;
    if (!$("fixed-lines").hidden) $("fixed-lines").replaceChildren(...gear.lines.map(line =>
      node("li",[line.stat,lineValue(line)].filter(Boolean).join(" · "))));
    renderTargets(eligible.map(effect => effect.name),koreaOnly,trends);
    if (current.lineId) renderResults(effects);
    renderCard(effects,trends,koreaOnly);
    renderPool(effects);
    $("mobile-odds").hidden = !hasTarget;
    $("mobile-primary").textContent = $("target-chance").textContent;
    $("mobile-combined").textContent = $("acceptable-chance").textContent;
  }

  function renderTargets(names,koreaOnly,trends) {
    const current = state();
    const sorted = names.slice().sort((a,b) => a.localeCompare(b));
    const selectable = sorted.filter(name => !koreaOnly.has(byName(name)));
    const valid = new Map(selectable.map(name => [byName(name),name]));
    current.targets = unique(current.targets.map(name => valid.get(byName(name))).filter(Boolean));
    if (!current.targets.length && selectable.length) {
      const bestMissing = trends.map(row => valid.get(byName(row.name))).find(Boolean);
      const gloveDefault = item().itemId == 210530114 && valid.get(byName("Perfect Chance"));
      current.targets = [gloveDefault || bestMissing || valid.get(byName("Attack")) || selectable[0]];
    }
    function targetOption(name) {
      const disabled = koreaOnly.has(byName(name));
      const result = option(name,disabled ? name + " · KR/TW only" : name);
      result.disabled = disabled;
      return result;
    }
    $("target").replaceChildren(...sorted.map(targetOption));
    $("target").value = current.targets[0] ?? "";
    $("target").disabled = !selectable.length;
    const others = sorted.filter(name => !current.targets.includes(name));
    const firstAlternative = others.find(name => valid.has(byName(name)));
    $("new-target").replaceChildren(...others.map(targetOption));
    $("new-target").value = firstAlternative ?? "";
    $("new-target").disabled = !firstAlternative;
    $("add-form").querySelector("button").disabled = !firstAlternative;
    const chips = $("target-list");
    chips.replaceChildren();
    for (const name of current.targets.slice(1)) {
      const remove = node("button",name + " ×","chip");
      remove.type = "button";
      remove.setAttribute("aria-label","Remove " + name);
      remove.onclick = () => {
        current.targets = current.targets.filter(effect => effect !== name);
        renderItem();
      };
      chips.append(remove);
    }
    $("other-targets").querySelector("summary").textContent = current.targets.length > 1
      ? "Other acceptable effects (" + (current.targets.length - 1) + ")" : "Other acceptable effects";
  }

  function rowsForItem(targets, retryFor = null, gear = item()) {
    const engine = window.AionSoulBinding;
    const observations = entry(bundle.observations,gear) ?? {};
    const rules = entry(bundle.rules,gear) ?? entry(bundle.alternateRules,gear);
    const assumed = new Set((rules?.assumedSelectableLineIds ?? []).map(String));
    const lines = gear.lines.map(line => ({
      ...line, rerollable: line.rerollable ?? (assumed.has(line.id) || null)
    }));
    const modeled = engine.rankLines({...gear,lines},rules,targets);
    const observed = engine.rankObserved({...gear,lines},observations,targets);
    return lines.map((line, i) => {
      const preview = observed.rows[i], estimate = modeled.rows[i];
      const readings = observations[line.id] ?? {};
      const hasTargets = targets.length > 0 && targets.every(name => Object.keys(readings).some(key => byName(key) === byName(name)));
      const read = preview.probability !== null || hasTargets || preview.status === "fixed";
      const row = read ? preview : estimate;
      // Use the model's full precision to compare previews that agree within their rounding bounds.
      const agrees = row.probability !== null && estimate.probability !== null &&
        Math.abs(row.probability - estimate.probability) <= targets.length * 0.000005 + 1e-12;
      let retry = null;
      if ((retryFor === true || retryFor === line.id) && agrees && (!imported || localModels.has(rules)) && rules?.retryPool) {
        retry = engine.retryAfterMiss(gear,rules,line.id,targets);
      }
      return {line,row,retry,comparison:agrees ? estimate.probability : row.probability,
        source:row.probability === null ? "" : read ? "In-game preview" : "Estimate"};
    });
  }

  function suggestedReroll(gear,top,held,trends,label = "Consensus") {
    const protectedNames = new Set(top.map(pair => byName(pair.name)));
    for (const pair of trends) {
      if (pair.usage >= 30) protectedNames.add(byName(pair.name));
    }
    const missing = top.map(pair => pair.name).filter(name => !held.has(byName(name)));
    if (!missing.length) return {reason:top.length === 6 ? "All six ideal lines are equipped." : "All planned ideal lines are equipped."};
    const candidates = rowsForItem(missing,true,gear).filter(({line,row}) =>
      row.status !== "fixed" && !protectedNames.has(byName(line.stat)));
    if (!candidates.length) {
      return {reason:"No reroll suggested. Every selectable line is ideal or has at least 30% " +
        (label === "Consensus" ? "consensus" : label) + " usage."};
    }
    const individual = missing.map(name => ({name,choices:rowsForItem([name],null,gear)}));
    const options = candidates.map(candidate => {
      const id = candidate.line.id;
      const outcomes = individual.map(({name,choices}) => ({name,...choices.find(choice => choice.line.id === id)}))
        .filter(effect => effect.row.probability > 0).sort((a,b) => b.comparison - a.comparison);
      // An imported line can have only a partial preview. Score the exact choices the button will apply.
      const choice = outcomes.length && outcomes.length < missing.length ?
        rowsForItem(outcomes.map(effect => effect.name),id,gear).find(row => row.line.id === id) : candidate;
      return {...choice,outcomes};
    });
    const preferred = states.get(gear.id)?.lineId ?? defaultLine(gear,trends)?.id;
    const best = options.filter(choice => choice.row.probability > 0 && choice.outcomes.length).sort((a,b) =>
      b.comparison - a.comparison || (b.retry ?? -1) - (a.retry ?? -1) ||
      Number(b.line.id === preferred) - Number(a.line.id === preferred))[0];
    if (best) return {best};
    return {reason:candidates.some(({row}) => row.probability === null)
      ? "There are too few known odds to suggest a reroll." : "These lines cannot roll a missing ideal effect."};
  }

  function useSuggestion(gear,best,origin = "editor") {
    states.set(gear.id,{lineId:best.line.id,targets:best.outcomes.map(effect => effect.name)});
    if (origin !== "editor") {
      if (origin === "upgrade") {
        returnScroll = window.scrollY;
        selectGear(gear);
        railMode = "item";
        showView("planner");
      }
      $("editor-back").hidden = origin !== "upgrade";
      setEditorOpen(true);
      $("inspect-toggle").focus({preventScroll:true});
      $("inspection").scrollIntoView({block:"start"});
    } else {
      renderItem();
      $("target").focus();
    }
  }

  function renderSuggestion(plan,held) {
    const top = plan.top;
    const panel = $("suggestion"), summary = $("suggestion-summary"), detail = $("suggestion-targets");
    const apply = $("apply-suggestion");
    const gear = item();
    panel.hidden = !plan.active && !(gear.lines.some(line=>line.rerollable !== false) && plan.choices.length);
    fillRecommendationMenu($("suggestion-ranking"),slotRankings(gear.slot).entries,plan.requested ?? plan.source);
    $("suggestion-fallback").hidden = !plan.requested;
    $("suggestion-fallback").textContent = plan.requested ? "No eligible lines in this source. Using Consensus." : "";
    apply.hidden = true;
    apply.onclick = null;
    detail.replaceChildren();
    summary.replaceChildren();
    if (panel.hidden) return;
    if (!plan.active) {
      summary.textContent = "No eligible ideal-line set is available for this item.";
      return;
    }
    const {best,reason} = suggestedReroll(gear,top,held,plan.ranked,plan.custom ? "Consensus" : plan.label);
    if (!best) {
      summary.textContent = reason;
      return;
    }
    const outcomes = best.outcomes;
    summary.append("Reroll ",node("strong",best.line.stat)," for a ",node("strong",chance(best.row.probability)),
      outcomes.length === 1 ? " chance to gain " + outcomes[0].name + "." :
      " chance to gain one of " + outcomes.length + " missing ideal lines.");
    if (outcomes.length > 1) {
      const leading = outcomes.filter(effect => effect.comparison === outcomes[0].comparison);
      detail.append(node("strong",list.format(leading.map(effect => effect.name))),
        leading.length > 1 ? " tie for most likely at " : " is most likely at ",chance(outcomes[0].row.probability),".");
      const others = outcomes.slice(leading.length);
      if (others.length) detail.append(" " + list.format(others.map(effect => effect.name)) +
        (others.length === 1 ? " also counts." : " also count."));
    }
    const targets = outcomes.map(effect => effect.name);
    const current = state();
    const applied = current.lineId === best.line.id && current.targets[0] === targets[0] &&
      current.targets.length === targets.length && targets.every(name => current.targets.includes(name));
    apply.hidden = false;
    apply.disabled = applied;
    apply.title = applied ? "The selected line and targets already match this model." :
      "Use this model to select the reroll line and calculate the target odds.";
    apply.onclick = () => useSuggestion(gear,best);
  }

  function renderUpgradePath() {
    const plans = [];
    const gearList = bundle?.snapshot.items ?? [];
    const named = new Map();
    for (const gear of gearList) {
      for (const row of slotRankings(gear.slot).entries) named.set("named-"+row.name.toLowerCase(),row.name);
    }
    const options = [...named].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name));
    fillRecommendationMenu($("upgrade-ranking"),options,upgradeChoice,true);
    upgradeChoice = $("upgrade-ranking").value;
    $("upgrade-ranking-note").hidden = !upgradeChoice.startsWith("named-");
    for (const gear of gearList) {
      const trends = slotTrends(gear);
      const plan = recommendationPlan(gear,trends,upgradeChoice), top = plan.top;
      if (!plan.active) continue;
      const held = new Set(gear.lines.map(line => byName(line.stat)));
      const {best} = suggestedReroll(gear,top,held,plan.ranked,plan.custom ? "Consensus" : plan.label);
      if (best) plans.push({gear,best,idealCount:equippedIdealCount(top,held),plan});
    }
    plans.sort((a,b) => b.best.row.probability - a.best.row.probability);
    const steps = $("upgrade-steps");
    steps.replaceChildren();
    $("upgrade-empty").hidden = plans.length > 0;
    $("upgrade-empty").textContent = classReference()?.globalGuide ? "No suggested rerolls are available for this loadout." :
      "No Global ideal-line sample is available for this class.";
    for (const {gear,best,idealCount,plan} of plans) {
      const step = node("li");
      const row = node("div",null,"upgrade-row"), heading = node("h3");
      const button = node("button",gear.name,"upgrade-item");
      button.type = "button";
      button.setAttribute("aria-label",[gear.name,gear.slot,"use suggested reroll"].filter(Boolean).join(", "));
      button.dataset.gearId = gear.id;
      button.onclick = () => {
        upgradePreview = {gearId:gear.id,source:plan.source};
        useSuggestion(gear,best,"upgrade");
      };
      heading.append(gearIcon(gear),button," ",node("small","(" + idealCount + " of " + plan.top.length +
        " ideal lines" + (upgradeChoice !== "consensus" ? " · " + plan.label : "") + ")","upgrade-count"));
      const odds = node("strong",chance(best.row.probability),"upgrade-chance");
      odds.title = best.source;
      const outgoing = node("p");
      if (gear.slot) outgoing.append(node("span",gear.slot,"upgrade-slot")," · ");
      outgoing.append("Reroll ",node("strong",best.line.stat)," → ",
        node("span",best.outcomes.map(effect => effect.name).join(" · "),"upgrade-targets"));
      row.append(heading,odds,outgoing);
      step.append(row);
      steps.append(step);
    }
  }

  function effectsForSelectedLine() {
    const rules = entry(bundle.rules) ?? entry(bundle.alternateRules);
    const pool = rules?.retryPool;
    const base = new Map();
    if (pool) {
      for (const [weights, share] of [[pool.statWeights, 1 - pool.skillShare], [pool.skillWeights, pool.skillShare]]) {
        const values = Object.entries(weights ?? {});
        const total = values.reduce((sum,[,weight]) => sum + weight,0);
        if (total > 0) for (const [name,weight] of values) base.set(byName(name),share * weight / total);
      }
    }
    const held = new Set(item().lines.map(line => byName(line.stat)));
    return targetCatalog().map(name => {
      const key = byName(name);
      const choice = held.has(key) ? null : rowsForItem([name]).find(choice => choice.line.id === state().lineId);
      return {name, held:held.has(key), base:base.get(key), probability:held.has(key) ? 0 : choice?.row.probability ?? null,
        source:choice?.source};
    });
  }

  function renderPool(effects) {
    const rows = [];
    for (const effect of effects) {
      const tr = node("tr"), header = node("th",effect.name);
      rows.push(tr);
      header.scope = "row";
      tr.append(header);
      tr.insertCell().textContent = effect.base == null ? "—" : rate(effect.base);
      tr.insertCell().textContent = effect.held ? "0% · on item" : effect.probability == null ? "Unknown" : rate(effect.probability);
    }
    layoutReference($("pool-rows"),rows);
    const rules = entry(bundle.rules) ?? entry(bundle.alternateRules);
    $("pool-source").replaceChildren();
    if (href(rules?.sourceUrl)) $("pool-source").append(link("Item weights and skill list",rules.sourceUrl));
    if (href(rules?.itemReference)) $("pool-source").append(" · ",link("Questlog Soul Imprint",rules.itemReference));
    $("pool").hidden = !effects.length;
  }

  function renderResults(effects) {
    const current = state(), results = $("results");
    const choices = rowsForItem(current.targets);
    results.replaceChildren();
    for (const {line,row} of choices) {
      const label = node("label",null,"line-option");
      const radio = node("input");
      radio.type = "radio";
      radio.name = "outgoing";
      radio.value = line.id;
      radio.checked = line.id === current.lineId;
      radio.disabled = row.status === "fixed";
      radio.setAttribute("aria-label","Reroll " + line.stat);
      radio.onchange = () => {
        current.lineId = line.id;
        renderItem();
        [...results.querySelectorAll("input")].find(input => input.value === line.id)?.focus();
      };
      label.append(radio,node("span",line.stat),node("small",radio.disabled ? "Fixed" : lineValue(line)));
      results.append(label);
    }
    const selected = choices.find(choice => choice.line.id === current.lineId);
    const primary = effects.find(effect => effect.name === current.targets[0]);
    $("target-chance").textContent = chance(primary?.probability);
    $("acceptable-chance").textContent = chance(selected?.row.probability);
    let note = "Any acceptable includes your target.";
    if (selected?.row.probability == null) note += " Combined odds are unavailable.";
    else if (primary?.source === "Estimate" || selected.source === "Estimate") note += " This roll uses modeled odds.";
    $("chance-note").textContent = note;
  }
  function attachKnownPools(next,items = next.snapshot.items) {
    const cls = className(next.snapshot.character.className);
    const equipment = window.AION_CLASS_DATA.equipment;
    next.rules = {...next.rules};
    next.catalog = {...next.catalog};
    for (const gear of items) {
      if (next.rules[gear.id] || next.rules[gear.itemId] || next.alternateRules?.[gear.id] ||
          next.alternateRules?.[gear.itemId] || gear.subStatRandom === false) continue;
      const pool = equipment.pools[equipment.items[gear.itemId]];
      const weights = equipment.skills[pool?.skillGroup]?.[cls];
      const activePool = pool && (!pool.skillShare || weights) ? {...pool,skillWeights:weights || {}} : null;
      const original = activePool && {status:"scenario",region:"GLOBAL",source:activePool.source,sourceUrl:activePool.source,
        itemReference:"https://questlog.gg/aion-2/en/db/item/" + gear.itemId,
        retryPool:{statWeights:activePool.statWeights,skillWeights:activePool.skillWeights,skillShare:activePool.skillShare}};
      if (!original?.retryPool) continue;
      const base = original.retryPool;
      const held = new Set(gear.lines.map(line => byName(line.stat)));
      const names = [...Object.keys(base.statWeights),...Object.keys(base.skillWeights)];
      next.catalog[gear.id] = names;
      if (![...held].every(key => names.some(name => byName(name) === key))) continue;
      const cap = gear.subSkillCountMax;
      if (base.skillShare && !Number.isInteger(cap)) continue;
      const skills = new Set(Object.keys(base.skillWeights).map(byName));
      const skillCount = gear.lines.filter(line => skills.has(byName(line.stat))).length;
      const groups = [[base.statWeights,1 - base.skillShare],[base.skillWeights,base.skillShare]]
        .map(([weights,share]) => ({entries:Object.entries(weights).filter(([name]) => !held.has(byName(name))),share}));
      const totals = groups.map(group => group.entries.reduce((sum,[,weight]) => sum + weight,0));
      if (groups.some((group,i) => group.share && !totals[i])) continue;
      // Scaling each group by the other group's total gives one exact integer pool for these catalog shares.
      const outcomes = groups.flatMap((group,i) => group.entries.map(([stat,weight]) => ({
        stat,weight:weight * Math.round(100 * group.share) * (totals[1-i] || 1)
      })));
      const byLine = Object.create(null);
      for (const line of gear.lines) {
        if (line.rerollable === false || (base.skillShare && skillCount - Number(skills.has(byName(line.stat))) >= cap)) continue;
        byLine[line.id] = {complete:true,exclude:"none",outcomes};
      }
      next.rules[gear.id] = {...original,itemId:gear.id,byLine,assumedSelectableLineIds:
        gear.lines.filter(line => line.rerollable == null && byLine[line.id]).map(line => line.id)};
      localModels.add(next.rules[gear.id]);
    }
  }
  function load(raw, origin) {
    let next = validate(raw);
    const focus = document.activeElement;
    const focusId = focus?.id, focusLabel = focus?.getAttribute("aria-label");
    const focusSlot = focus?.closest(".gear-btn")?.dataset.slot;
    const oldItem = itemIfLoaded();
    const oldSnapshot = bundle?.snapshot, oldStates = states, wasImported = imported;
    const prevProfile = oldSnapshot?.character;
    const newProfile = next.snapshot.character;
    const identityFields = prevProfile?.characterId && newProfile.characterId ? ["characterId","serverId","region"] : ["name","server","region"];
    const oldKey = oldSnapshot && profileKey(profileIdentity(oldSnapshot));
    const newKey = profileKey(profileIdentity(next.snapshot));
    const sameCharacter = oldKey && newKey ? oldKey === newKey : prevProfile && identityFields.every(k =>
      String(prevProfile[k] ?? "") === String(newProfile[k] ?? ""));
    if (!sameCharacter) {
      pinDraft = null;
      upgradePreview = null;
      upgradeChoice = "consensus";
      anonymousSources.clear();
    }
    const sameItem = sameCharacter && oldItem ? next.snapshot.items.find(x=>x.id === oldItem.id &&
      x.name === oldItem.name && String(x.itemId) === String(oldItem.itemId)) : null;
    imported = origin === "import";
    attachKnownPools(next);
    bundle = next;
    const classSelect = $("guide-class"), characterClass = className();
    if (!classSelect.options.length) {
      const names = Object.keys(window.AION_CLASS_DATA.guides).sort();
      classSelect.replaceChildren(...names.map(n => option(n,n + (classReference(n)?.globalGuide ? "" : " (KR/TW only)"))));
    }
    if (!sameCharacter || !classSelect.value || prevProfile?.className !== newProfile.className)
      classSelect.value = classReference() ? characterClass : "Cleric";
    $("open-guide").title = characterClass + " build guide";
    states = new Map();
    if (origin === "refresh" && sameCharacter && !wasImported) {
      for (const gear of bundle.snapshot.items) {
        const prior = oldStates.get(gear.id);
        if (!prior || !oldSnapshot.items.some(old => old.id === gear.id && old.itemId === gear.itemId)) continue;
        const lineId = gear.lines.find(line => line.id === prior.lineId && line.rerollable !== false)?.id ??
          gear.lines.find(line => line.rerollable !== false)?.id;
        states.set(gear.id,{lineId,targets:[...prior.targets]});
      }
    }
    const snapshot = bundle.snapshot, ch = snapshot.character;
    const region = regionNames[ch.region] || ch.region;
    $("profile").textContent = [ch.name,ch.level ? "Lv " + ch.level + " " + (ch.className || "") : ch.className,
      ch.server,region,ch.combatPower ? fm.format(ch.combatPower) + " CP" : ""].filter(Boolean).join(" · ");
    const d = new Date(snapshot.retrievedAt);
    const timestamp = snapshot.retrievedAt && !Number.isNaN(d.getTime()) ?
      new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"long"}).format(d) : "time unavailable";
    $("freshness").textContent = (imported ? "Imported snapshot · " : "Gear snapshot · ") + timestamp;
    $("source-link").replaceChildren();
    if (href(snapshot.sourceUrl)) $("source-link").append(link("Character source ↗",snapshot.sourceUrl));
    $("workspace").hidden = false;
    const keepItem = sameItem && (origin === "refresh" || origin === "bundle");
    selectedId = keepItem ? sameItem.id : null;
    renderBoard();
    if (keepItem) {
      selectGear(sameItem);
      drawRail(railMode);
    } else {
      drawRail("none");
      if (!sameCharacter || origin === "cached") showView("planner");
    }
    if (!$("upgrade-view").hidden) renderUpgradePath();
    if (!$("guide-view").hidden) renderGuide();
    renderQuickSwitch();
    scheduleAutoRefresh();
    if (origin === "refresh" && sameCharacter && focus && !focus.isConnected) {
      const replacement = focusId && $(focusId) || (focusSlot && [...gearButtons.values()].find(b=>b.dataset.slot === focusSlot)) ||
        (focusLabel && [...document.querySelectorAll("[aria-label]")].find(el=>el.getAttribute("aria-label") === focusLabel));
      replacement?.focus({preventScroll:true});
    }
    if (!oldSnapshot) {
      $("planner").classList.remove("first-character");
      $("character-heading").textContent = "Find a character";
      setPicker(false);
    }
  }
  function itemIfLoaded() { return bundle ? item() : null; }

  const guideSelections = {};
  let category = "soul";
  let guideRegion = $("guide-region").value;
  function guideTable(title, headings, rows) {
    const section = node("section"), table = node("table");
    const scroll = node("div",null,"guide-table-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role","region");
    scroll.setAttribute("aria-label",title + " data");
    scroll.append(table);
    section.append(node("h3",title),scroll);
    table.setAttribute("aria-label",title);
    const headers = table.createTHead().insertRow();
    for (const text of headings) {
      const header = node("th",text);
      header.scope = "col";
      headers.append(header);
    }
    const body = table.createTBody();
    for (const values of rows) {
      const tr = body.insertRow(), header = node("th",values[0]);
      header.scope = "row";
      tr.append(header);
      for (const value of values.slice(1)) tr.insertCell().textContent = value;
    }
    return section;
  }

  function renderGuide() {
    const selected = $("guide-class").value, reference = classReference(selected);
    const korea = reference.buildGuide, global = reference.globalGuide || {soul:{},stones:{},arcana:{},skills:{},traits:{}};
    $("guide-title").textContent = selected + " build guide";
    $("guide-source").replaceChildren(link("NotMeter build guide",korea.source));
    const sample = $("guide-region");
    const soul = category === "soul";
    sample.querySelector('[value="consensus"]').textContent = soul ? "Consensus" : "NotMeter comparison";
    for (const opt of sample.options)
      opt.disabled = !reference.globalGuide && opt.value !== "notmeter" && !(soul && opt.value === "consensus");
    sample.value = sample.querySelector('[value="'+guideRegion+'"]').disabled ? "notmeter" : guideRegion;
    const region = $("guide-region").value, consensus = region === "consensus";
    const guide = region === "notmeter" || !reference.globalGuide ? korea : global;
    const options = Object.keys(guide[category]);
    if (consensus) for (const name of Object.keys(korea[category])) if (!options.includes(name)) options.push(name);
    if (category === "arcana") options.push("Set combinations");
    const group = options.includes(guideSelections[category]) ? guideSelections[category] : options[0];
    $("guide-filter").replaceChildren(...options.map(name => option(name,name)));
    $("guide-filter").value = group;
    $("guide-filter-label").textContent = {soul:"Equipment slot",stones:"Stone type",arcana:"Arcana",skills:"Skill type"}[category];
    for (const button of $("guide-categories").querySelectorAll("button"))
      button.setAttribute("aria-pressed",String(button.dataset.category === category));
    const active = category === "skills" && group === "Active skills";
    $("skill-filter-label").hidden = !active;
    $("consensus-note").hidden = !consensus;
    const date = new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"America/New_York"})
      .format(new Date(guide.updated));
    $("guide-meta").textContent = (consensus ? (global.sampleSize ?? 0) + " Global and " + korea.sampleSize + " KR/TW" :
      guide.sampleSize + " " + guide.service) + " " + selected + " players · " + date + ".";
    if (consensus && soul) {
      $("guide-meta").textContent = "NotMeter: " + (global.sampleSize ?? 0) + " Global and " + korea.sampleSize +
        " KR/TW · Kisk: " + reference.ideals.sampleSize + " Korean PvE " + selected + " players.";
      $("guide-source").append(" · ",link("Kisk rankings",reference.ideals.method));
    }
    $("consensus-note").textContent = soul ? consensusNote :
      "NotMeter combines player counts when both regions list a choice. A dash means the region did not list it.";
    const target = $("guide-sections");
    target.classList.toggle("comparison",consensus);
    target.replaceChildren();

    function addUsage(title, globalRows = [], koreaRows = [], detailHeading = "", traitTable = false, kiskRows) {
      if (consensus) {
        const pairs = kiskRows ? consensusUsage(globalRows,koreaRows,kiskRows) : compareUsage(globalRows,koreaRows,reference);
        if (!pairs.length) return;
        if (traitTable) pairs.sort((a,b) => (a.global ?? a.korea).number - (b.global ?? b.korea).number);
        function regionalCell(row, sample) {
          if (!row) return "—";
          return row.usage + "% · " + row.used + "/" + (row.sample ?? sample) + (row.detail ? " · " + row.detail : "");
        }
        if (kiskRows) {
          target.append(guideTable(title,["Choice","Global","KR/TW","Kisk","Consensus"],pairs.map(row => [
            row.name,regionalCell(row.global,global.sampleSize),regionalCell(row.korea,korea.sampleSize),
            row.kisk ? fm.format(row.kisk.usage) + "%" : "—",consensusFormat.format(row.usage) + "%"
          ])));
          return;
        }
        target.append(guideTable(title,["Choice","Global","KR/TW","Combined"],pairs.map(pair => [
          pair.name,regionalCell(pair.global,global.sampleSize),regionalCell(pair.korea,korea.sampleSize),
          pair.sample ? fm.format(Math.round(pair.usage * 10) / 10) + "% · " + pair.used + "/" + pair.sample :
          pair.global ? "Global only" : "KR/TW only"
        ])));
      } else {
        const rows = region === "global" ? globalRows : koreaRows;
        if (!rows.length) return;
        const headings = [traitTable ? "Trait and effect" : "Choice","Players","Usage"];
        if (detailHeading) headings.push(detailHeading);
        target.append(guideTable(title,headings,rows.map(row => {
          const fields = [row.name,row.used + "/" + (row.sample ?? guide.sampleSize),row.usage + "%"];
          if (detailHeading) fields.push(row.detail || "—");
          return fields;
        })));
      }
    }

    if (category === "soul") {
      const slot = Object.keys(guideSlotLabels).find(key=>guideSlotLabels[key] === group) ?? group;
      const kisk = reference.ideals?.slots[slot] ?? [];
      const skills = new Set([...(global.soul[group]?.Skills ?? []),...(korea.soul[group]?.Skills ?? [])].map(row=>byName(row.name)));
      for (const [key,title] of [["Options","Stat lines"],["Skills","Skill lines"]]) {
        const rows = kisk.filter(row => (row.source === "gearCard" || skills.has(byName(row.effect))) === (key === "Skills"));
        addUsage(title,global.soul[group]?.[key],korea.soul[group]?.[key],"",false,rows);
      }
    } else if (category === "stones") {
      addUsage(group,global.stones[group],korea.stones[group],"Total socketed");
      target.prepend(node("p","NotMeter includes damage-boost stones in these samples.","card-note"));
    } else if (category === "arcana") {
      if (group === "Set combinations") addUsage(group,global.arcanaSets,korea.arcanaSets,"Reported total");
      else for (const key of ["Most-used cards","Most-used attached skills"]) {
        addUsage(key,global.arcana[group]?.[key],korea.arcana[group]?.[key],key.includes("skills") ? "Level" : "");
      }
    } else if (active) {
      const choices = consensus ? unique([...global.skills[group],...korea.skills[group]].map(row => row.name)) :
        guide.skills[group].map(row => row.name);
      const skill = choices.includes(guideSelections.skillName) ? guideSelections.skillName : choices[0];
      $("skill-filter").replaceChildren(...choices.map(name => option(name,name)));
      $("skill-filter").value = skill;
      addUsage(skill,(global.skills[group] || []).filter(row => row.name === skill),
        korea.skills[group].filter(row => row.name === skill),"Typical level");
      // Two services can assign different effects to the same numbered trait.
      const traits = source => (source.traits[skill] ?? []).map(t => ({...t,name:t.number + ". " + t.description}));
      addUsage("Active skill traits",traits(global),traits(korea),"",true);
      target.append(node("p","Trait counts use verified selections for this skill. Region-specific versions appear separately.","card-note"));
    } else addUsage(group,global.skills[group],korea.skills[group],"Typical level");
  }

  function showView(name) {
    hideGearTip();
    if (name !== "planner") upgradePreview = null;
    for (const view of ["planner","upgrade","guide"]) {
      $(view + "-view").hidden = view !== name;
      $("open-" + view).setAttribute("aria-pressed",String(view === name));
    }
    setEditorOpen(false);
    $("characters").open = false;
    if (name === "planner") drawRail(railMode);
    if (name === "upgrade") renderUpgradePath();
    if (name !== "guide") return;
    const guide = classReference($("guide-class").value).buildGuide;
    if (!guideSelections.soul && itemIfLoaded() && own(guide.soul,guideSlot())) guideSelections.soul = guideSlot();
    $("guide-source").replaceChildren(link("NotMeter · Class Build Guide",guide.source));
    renderGuide();
  }
  $("open-guide").onclick = () => showView("guide");
  $("open-upgrade").onclick = () => showView("upgrade");
  $("guide-region").onchange = event => {
    guideRegion = event.target.value;
    renderGuide();
  };
  $("guide-class").onchange = renderGuide;
  $("open-planner").onclick = () => { railMode = "none"; showView("planner"); };
  for (const button of $("guide-categories").querySelectorAll("button")) button.onclick = () => {
    category = button.dataset.category;
    renderGuide();
  };
  $("guide-filter").onchange = event => {
    guideSelections[category] = event.target.value;
    renderGuide();
  };
  $("skill-filter").onchange = event => {
    guideSelections.skillName = event.target.value;
    renderGuide();
  };
  $("inspect-toggle").onclick = () => setEditorOpen($("editor").hidden);
  $("editor-back").onclick = backFromEditor;
  $("board-return").onclick = returnToSlot;
  document.addEventListener("click",event => {
    if (!$("characters").contains(event.target)) $("characters").open = false;
  });
  document.addEventListener("keydown",event => {
    if (event.key !== "Escape" || !bundle) return;
    if (tipAnchor) { hideGearTip(); return; }
    if ($("characters").open) { $("characters").open = false; $("characters").querySelector("summary").focus(); }
    else if (!$("character-picker").hidden) { setPicker(false); $("characters").querySelector("summary").focus(); }
    else if (!$("editor").hidden) backFromEditor();
    else if (!$("planner-view").hidden && railMode === "item") {
      drawRail("none");
      gearButtons.get(selectedId)?.focus();
    }
  });
  $("ranking-source").onchange = async event => {
    const value = event.target.value, slot = item().slot, key = pinKey(slot);
    const custom = value.startsWith("custom-");
    pinDraft = null;
    if (!custom) builtinView = value;
    if (!custom && !slotRankings(slot).active) return renderItem();
    upgradePreview = null;
    await writeRankings(key,book=>{
      if (custom && !book.entries.some(row=>row.id === value)) throw new Error("This ranking is no longer available.");
      book.active = custom ? value : null;
      if (!custom) book.source = "consensus";
    });
    if (itemIfLoaded() && pinKey(item().slot) === key) drawRail("item");
  };
  async function chooseRecommendation(event) {
    const value = event.target.value || "consensus", control = event.target.id;
    const gear = item(), key = pinKey(gear.slot);
    if (key) {
      const saved = await writeRankings(key,book=>{
        const named = book.entries.find(row=>row.id === value);
        if (!named && !recommendationSources.has(value)) throw new Error("This ranking is no longer available.");
        book.active = named?.id ?? null;
        book.source = named ? "consensus" : value;
      });
      if (!itemIfLoaded() || pinKey(item().slot) !== key) return;
      if (!saved) { drawRail("item"); return; }
    } else anonymousSources.set(gear.slot,recommendationSources.has(value) ? value : "consensus");
    upgradePreview = null;
    if (recommendationSources.has(value)) builtinView = value;
    drawRail("item");
    if (control === "rail-ranking") $(control)?.focus({preventScroll:true});
  }
  $("suggestion-ranking").onchange = chooseRecommendation;
  $("upgrade-ranking").onchange = event => {
    upgradeChoice = event.target.value || "consensus";
    renderUpgradePath();
  };
  $("target").onchange = event => {
    if (event.target.selectedOptions[0]?.disabled) { renderItem(); return; }
    const current = state();
    current.targets = unique([event.target.value,...current.targets.slice(1)]);
    renderItem();
  };
  function addAcceptable(name) {
    if (!name || ![...$("new-target").options].some(option => !option.disabled && option.value === name)) return false;
    state().targets.push(name);
    renderItem();
    return true;
  }
  $("add-form").onsubmit = event => {
    event.preventDefault();
    addAcceptable($("new-target").value);
  };
  function setPicker(open) {
    $("characters").open = false;
    $("character-picker").hidden = !open;
    $("change-character").setAttribute("aria-expanded",String(open));
    $("character-search").querySelector("button").textContent = liveMode ? "Search" : "Search in live planner";
    clearSearch();
    if (open) {
      const region = bundle?.snapshot.character.region;
      if (own(regionNames,region)) $("find-region").value = region;
      $("find-name").focus({preventScroll:true});
    }
  }
  function clearSearch() {
    searchRevision++;
    nextSearchPage = 1;
    $("character-matches").replaceChildren();
    $("more-characters").hidden = true;
    $("find-status").textContent = "";
  }
  async function armoryRequest(path,params,signal = AbortSignal.timeout(90000)) {
    return window.FolioArmory.request(path,params,signal);
  }
  async function findCharacters(append) {
    if (!append) clearSearch();
    const name = $("find-name").value.trim(), region = $("find-region").value;
    if (!name) { $("find-name").focus(); return; }
    const revision = ++searchRevision;
    $("find-status").textContent = "Searching the armory…";
    $("more-characters").hidden = true;
    try {
      const result = await armoryRequest("./api/characters",{name,region,page:nextSearchPage});
      if (revision !== searchRevision) return;
      const matches = $("character-matches");
      for (const profile of result.matches) {
        const button = node("button"), li = node("li");
        button.type = "button";
        button.append(node("strong",profile.name),node("small",profile.server + " · " + regionNames[profile.region]));
        button.onclick = () => {
          const saved = savedCharacters.get(profileKey(profile));
          if (saved) openSaved(saved);
          else loadLive(profile,true);
        };
        li.append(button);
        matches.append(li);
      }
      $("find-status").textContent = matches.childElementCount ? "Select the character on your server." : "No matching characters in this region.";
      nextSearchPage++;
      $("more-characters").hidden = !result.hasMore;
    } catch (error) {
      if (revision !== searchRevision) return;
      $("find-status").textContent = "Search failed. " + error.message;
      $("more-characters").hidden = !append;
    }
  }
  $("change-character").onclick = () => setPicker($("character-picker").hidden);
  $("find-name").oninput = $("find-region").onchange = clearSearch;
  $("character-search").onsubmit = event => {
    if (liveMode) { event.preventDefault(); findCharacters(false); }
  };
  $("more-characters").onclick = () => findCharacters(true);

  function profileIdentity(snapshot) {
    const ch = snapshot.character;
    if (ch.characterId) return ch;
    // Older snapshots put the stable ID in the official profile link.
    try {
      const url = new URL(snapshot.sourceUrl), params = url.searchParams;
      if (url.origin === "https://aion2.plaync.com" && url.pathname === "/api/character/info" &&
          params.get("region") === ch.region && params.get("serverId") === String(ch.serverId)) {
        return {...ch,characterId:params.get("characterId")};
      }
    } catch { /* An imported snapshot may have no public profile link. */ }
    return ch;
  }
  const rememberedProfile = "aion2.sync.profile.v1";
  const autoRefreshPreference = "aion2.sync.autoRefresh";
  let autoRefreshTimer, autoRefreshEnabled = false;
  try { autoRefreshEnabled = localStorage.getItem(autoRefreshPreference) === "on"; } catch { /* Use the session setting. */ }
  function scheduleAutoRefresh() {
    clearTimeout(autoRefreshTimer);
    const button = $("auto-refresh");
    const profile = bundle && profileIdentity(bundle.snapshot);
    button.hidden = !liveMode || !profileKey(profile) || !own(regionNames,profile.region);
    button.setAttribute("aria-pressed",String(autoRefreshEnabled));
    if (autoRefreshEnabled && !button.hidden && !gearRequest) {
      autoRefreshTimer = setTimeout(() => loadLive(profile,false,true),10 * 60 * 1000);
    }
  }
  $("auto-refresh").onclick = () => {
    autoRefreshEnabled = !autoRefreshEnabled;
    try { localStorage.setItem(autoRefreshPreference,autoRefreshEnabled ? "on" : "off"); } catch { /* Use the session setting. */ }
    scheduleAutoRefresh();
  };
  const savedCharacters = new Map();
  let profileDb = null, savingProfile = false;
  let profileChanges = null, switchRevision = 0;
  function profileKey(profile) {
    return profile?.characterId && profile.serverId && profile.region ?
      JSON.stringify([profile.region,String(profile.serverId),profile.characterId]) : "";
  }
  function remember(profile) {
    const {region,serverId,characterId,name,server} = profile;
    try {
      const selection = JSON.stringify({region,serverId,characterId,name,server});
      sessionStorage.setItem(rememberedProfile,selection);
      localStorage.setItem(rememberedProfile,selection);
    } catch { /* Storage is optional. */ }
  }
  async function readSavedCharacters() {
    profileDb = await new Promise((resolve,reject) => {
      const request = indexedDB.open("aion2-sync-characters",1);
      request.onupgradeneeded = () => request.result.createObjectStore("profiles",{keyPath:"key"});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (typeof BroadcastChannel === "function") {
      try {
        profileChanges = new BroadcastChannel("aion2-sync-characters");
        profileChanges.onmessage = ({data:key}) => {
          if (typeof key === "string") readSavedRecord(key).then(renderQuickSwitch).catch(() => {});
        };
      } catch { /* Each selection still reads the shared database. */ }
    }
    const records = await new Promise((resolve,reject) => {
      const request = profileDb.transaction("profiles").objectStore("profiles").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const record of records) savedCharacters.set(record.key,record);
    renderQuickSwitch();
  }
  function readSavedRecord(key) {
    return new Promise((resolve,reject) => {
      const request = profileDb.transaction("profiles").objectStore("profiles").get(key);
      request.onsuccess = () => {
        if (request.result) savedCharacters.set(key,request.result);
        else savedCharacters.delete(key);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }
  function renderQuickSwitch() {
    if (!bundle) return;
    const profile = profileIdentity(bundle.snapshot), key = profileKey(profile);
    const select = $("quick-character"), button = $("save-character");
    const options = [...savedCharacters.values()].map(record => {
      const ch = record.data.snapshot.character;
      return option(record.key,[ch.name,ch.server,regionNames[ch.region]].filter(Boolean).join(" · "));
    }).sort((a,b) => a.text.localeCompare(b.text));
    select.replaceChildren(option("",options.length ? "Select a saved character" : "No saved characters"),...options);
    select.disabled = !options.length;
    select.value = savedCharacters.has(key) ? key : "";
    button.disabled = !profileDb || !key || savingProfile;
    button.textContent = savedCharacters.has(key) ? "Remove Saved Character" : "Add current character";
    const pulled = new Date(bundle.snapshot.retrievedAt);
    $("quick-pulled").textContent = Number.isFinite(pulled.getTime()) ?
      "Gear pulled " + pulled.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}) : "";
  }
  function cachedRecord() {
    const data = {snapshot:bundle.snapshot};
    for (const field of ["rules","catalog","alternateRules","observations","observationNotes","benchmarks"])
      if (bundle[field]) data[field] = bundle[field];
    if (imported && data.rules) {
      data.rules = Object.fromEntries(Object.entries(data.rules).filter(([,rule]) => !localModels.has(rule)));
    }
    return {key:profileKey(profileIdentity(data.snapshot)),data,imported};
  }
  function writeSaved(record,mode) {
    return new Promise((resolve,reject) => {
      const tx = profileDb.transaction("profiles","readwrite"), store = tx.objectStore("profiles");
      let retained = record;
      if (mode === "remove") { store.delete(record.key); retained = null; }
      else {
        const read = store.get(record.key);
        read.onsuccess = () => {
          retained = read.result;
          const newerSaved = retained && Date.parse(retained.data.snapshot.retrievedAt) > Date.parse(record.data.snapshot.retrievedAt);
          if ((retained || mode === "add") && !newerSaved) {
            store.put(record);
            retained = record;
          }
        };
      }
      tx.oncomplete = () => {
        if (retained) savedCharacters.set(record.key,retained);
        else savedCharacters.delete(record.key);
        renderQuickSwitch();
        if (retained || mode === "remove") profileChanges?.postMessage(record.key);
        resolve();
      };
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
  function openSaved(record) {
    gearRequest?.abort();
    gearRequest = null;
    $("refresh").disabled = false;
    load(record.data,record.imported ? "import" : "cached");
    remember(profileIdentity(bundle.snapshot));
    setPicker(false);
    feedback("");
  }
  $("quick-character").onchange = async event => {
    const key = event.target.value;
    if (!key) return;
    const revision = ++switchRevision, previous = bundle;
    clearTimeout(autoRefreshTimer);
    gearRequest?.abort();
    gearRequest = null;
    $("refresh").disabled = false;
    try {
      const record = await readSavedRecord(key);
      if (revision !== switchRevision || previous !== bundle) return;
      if (record) openSaved(record);
      else {
        renderQuickSwitch();
        feedback("This character was removed from quick switch.");
      }
    } catch {
      if (revision === switchRevision && previous === bundle) {
        renderQuickSwitch();
        feedback("The browser could not read the saved character.");
      }
    } finally {
      if (revision === switchRevision && previous === bundle) scheduleAutoRefresh();
    }
  };
  $("save-character").onclick = async () => {
    const record = cachedRecord();
    savingProfile = true;
    renderQuickSwitch();
    try {
      const mode = savedCharacters.has(record.key) ? "remove" : "add";
      await writeSaved(record,mode);
      const current = profileIdentity(bundle.snapshot);
      if (mode === "add" && profileKey(current) === record.key) remember(current);
    } catch { feedback("The browser could not save the change to your quick switch list."); }
    finally { savingProfile = false; renderQuickSwitch(); }
  };
  async function loadLive(profile,fromPicker = false,forceRefresh = false) {
    switchRevision++;
    if (!liveMode) {
      setPicker(true);
      return;
    }
    if (!profile?.characterId || !profile.serverId || !own(regionNames,profile.region)) {
      setPicker(true);
      feedback("Select this character on its server to refresh from the armory.");
      return;
    }
    clearTimeout(autoRefreshTimer);
    gearRequest?.abort();
    const request = new AbortController();
    gearRequest = request;
    const timeout = setTimeout(() => request.abort(),90000);
    $("refresh").disabled = true;
    feedback("Loading " + profile.name + " on " + profile.server + "…");
    try {
      const {region,serverId,characterId} = profile;
      const params = {region,serverId,characterId};
      if (forceRefresh) params.refresh = "1";
      const result = await armoryRequest("./api/gear",params,request.signal);
      if (gearRequest !== request) return;
      const actual = profileIdentity(result.snapshot);
      if (actual.region !== region || String(actual.serverId) !== String(serverId) || actual.characterId !== characterId) {
        throw new Error("The armory returned a different character.");
      }
      const missingDetails = result.snapshot.items.some(gear=>!record(gear.armoryDetails));
      legacyGearResponse = missingDetails;
      if (missingDetails && !fromPicker) {
        if (bundle && railMode === "item") drawRail(railMode);
        throw new Error(restartHelp);
      }
      load(result,"refresh");
      if (fromPicker) remember(actual);
      const message = "Loaded " + actual.name + " on " + actual.server + " · " + regionNames[region] + ".";
      let storageWarning = "";
      if (profileDb) {
        try { await writeSaved(cachedRecord(),fromPicker ? "add" : "refresh"); }
        catch { storageWarning = fromPicker ? " The browser could not save this character to Quick switch." : " The browser could not update the saved copy."; }
      } else if (fromPicker) storageWarning = " Browser storage is unavailable for Quick switch.";
      if (gearRequest !== request) return;
      if (fromPicker) setPicker(false);
      const savedNotice = fromPicker && !storageWarning ? " Saved to Quick switch." : "";
      feedback(message + savedNotice + (missingDetails ? " " + restartHelp : "") + storageWarning,!missingDetails && !storageWarning);
      if (fromPicker) $("profile").focus();
    } catch (error) {
      if (gearRequest === request) {
        const current = bundle?.snapshot.character;
        feedback(current ? "Refresh failed for " + profile.name + " on " + profile.server + ". Showing " +
          current.name + " on " + current.server + ". " + error.message :
          "Could not load " + profile.name + " on " + profile.server + ". " + error.message + " Select the character to retry.");
      }
    }
    finally {
      clearTimeout(timeout);
      if (gearRequest === request) {
        gearRequest = null;
        $("refresh").disabled = false;
        scheduleAutoRefresh();
      }
    }
  }
  $("refresh").onclick = () => loadLive(profileIdentity(bundle.snapshot),false,true);
  try {
    if (!window.AionSoulBinding) throw new Error("The probability engine is missing.");
    if (!window.AION_CLASS_DATA) throw new Error("The class reference data could not be loaded.");
    readSavedCharacters().catch(() => {
      profileDb = null;
      $("save-character").title = "Browser storage is unavailable.";
    }).then(() => {
      if (bundle || gearRequest) return;
      let profile;
      try {
        const saved = sessionStorage.getItem(rememberedProfile) || localStorage.getItem(rememberedProfile);
        if (saved) profile = JSON.parse(saved);
      } catch { /* Fall back to another saved character. */ }
      const cached = savedCharacters.get(profileKey(profile)) || savedCharacters.values().next().value;
      if (cached) openSaved(cached);
      else setPicker(true);
      if (liveMode) {
        const url = new URL(location.href);
        const name = url.searchParams.get("name")?.trim(), region = url.searchParams.get("region");
        if (name && name.length <= 64 && own(regionNames,region)) {
          setPicker(true);
          $("find-name").value = name;
          $("find-region").value = region;
          url.searchParams.delete("name");
          url.searchParams.delete("region");
          history.replaceState(null,"",url);
          findCharacters(false);
        }
      }
    });
  } catch (error) {
    feedback(error.message);
  }
})();
