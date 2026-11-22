/* Standalone browser script and CommonJS module. Each roll replaces one selected effect. */
(function (root, create) {
  const api = create();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AionSoulBinding = api;
})(globalThis, function () {
  "use strict";

  const own = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const label = value => typeof value === "string" ? value.trim().replace(/[‘’]/g, "'").replace(/\s+/g," ").toLowerCase() : "";
  const validWeight = value => Number.isFinite(value) && value >= 0;

  function readTargets(targets, allowMinimum) {
    const wanted = new Map();
    if (!Array.isArray(targets) || !targets.length) return null;
    for (const target of targets) {
      const name = label(typeof target === "string" ? target : target?.stat);
      const hasMinimum = record(target) && own(target, "min");
      if (!name || (hasMinimum && (!allowMinimum || !Number.isFinite(target.min)))) return null;
      const minimum = hasMinimum ? target.min : -Infinity;
      // An OR of thresholds on the same stat is equivalent to the lowest threshold.
      wanted.set(name, Math.min(wanted.get(name) ?? Infinity, minimum));
    }
    return wanted;
  }

  // Source weights are finite decimal numbers. Use integer totals to compare
  // ratios exactly, including ties between distributions with different scales.
  function decimalPart(value) {
    const [mantissa, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    return { units: BigInt(whole + fraction), power: Number(exponent) - fraction.length };
  }

  function scaleWeights(weights) {
    const parts = weights.map(decimalPart);
    const power = parts.reduce((lowest, part) => Math.min(lowest, part.power), 0);
    return {
      units: parts.map(part => part.units * 10n ** BigInt(part.power - power)),
      asNumber: units => Number(String(units) + "e" + power)
    };
  }

  function emptyRow(line, status, reason) {
    return {
      lineId: line?.id ?? null, stat: line?.stat ?? "", status, reason,
      rank: null, probability: null, favorableWeight: null, totalWeight: null
    };
  }

  function calculated(line, numerator, denominator, scaled) {
    if (!denominator) return emptyRow(line, "unavailable", "No positive-weight outcomes remain.");
    const favorableWeight = scaled.asNumber(numerator);
    const totalWeight = scaled.asNumber(denominator);
    if (!Number.isFinite(totalWeight)) return emptyRow(line, "unavailable", "The source weights exceed the numeric range.");
    return {
      lineId: line.id, stat: line.stat, status: "calculated", reason: "", rank: null,
      favorableWeight, totalWeight, probability: favorableWeight / totalWeight,
      exact: { numerator: String(numerator), denominator: String(denominator) }
    };
  }

  function readRuleSet(item, rules) {
    if (!record(rules)) return "No Global probability table is loaded for this item.";
    if (rules.region !== "GLOBAL") return "The probability table is for a different region.";
    if (rules.itemId == null || ![item.id, item.itemId].some(id => id != null && String(id) === String(rules.itemId))) {
      return "The probability table does not match this item.";
    }
    if (!["verified", "scenario"].includes(rules.status) || !label(rules.source)) {
      return "The probability table needs a source and verification status.";
    }
    if (rules.status === "verified") {
      try {
        const url = new URL(rules.source);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        return "A verified table needs a public source URL.";
      }
    }
    return record(rules.byLine) ? "" : "The source does not provide per-line distributions.";
  }

  function weightedRow(item, line, rules, wanted) {
    const table = rules.byLine[line.id];
    if (!own(rules.byLine, line.id) || !record(table) || table.complete !== true ||
        !Array.isArray(table.outcomes) || !table.outcomes.length) {
      return emptyRow(line, "unavailable", "The complete distribution for this line is unavailable.");
    }
    if (!["none", "retained", "all-current"].includes(table.exclude)) {
      return emptyRow(line, "unavailable", "The source does not specify how existing stats affect this draw.");
    }
    const excluded = new Set();
    if (table.exclude !== "none") {
      for (const other of item.lines) {
        if (other === line && table.exclude === "retained") continue;
        const stat = label(other?.stat);
        if (!stat) return emptyRow(line, "unavailable", "A current stat needed for the exclusion rule is missing.");
        excluded.add(stat);
      }
    }

    const hits = [];
    const weights = [];
    for (const outcome of table.outcomes) {
      const stat = label(outcome?.stat);
      if (!stat || !validWeight(outcome.weight)) {
        return emptyRow(line, "unavailable", "A source outcome has an invalid stat or weight.");
      }
      if (excluded.has(stat) || outcome.weight === 0) continue;
      const minimum = wanted.get(stat);
      if (minimum !== undefined && minimum !== -Infinity && !Number.isFinite(outcome.value)) {
        return emptyRow(line, "unavailable", "The source lacks the value distribution needed for this minimum.");
      }
      weights.push(outcome.weight);
      hits.push(minimum === -Infinity || (minimum !== undefined && outcome.value >= minimum));
    }
    const scaled = scaleWeights(weights);
    let total = 0n;
    let favorable = 0n;
    scaled.units.forEach((units, index) => {
      total += units;
      if (hits[index]) favorable += units;
    });
    return calculated(line, favorable, total, scaled);
  }

  function observedRow(line, entries, wanted) {
    if (!record(entries)) return emptyRow(line, "unavailable", "No captured preview for this line.");
    const seen = new Set();
    const hits = [];
    const percentages = [];
    for (const [rawName, percent] of Object.entries(entries)) {
      const name = label(rawName);
      if (!name || seen.has(name) || !validWeight(percent) || percent > 100) {
        return emptyRow(line, "unavailable", "Each observed stat needs one percentage from 0 to 100.");
      }
      seen.add(name);
      percentages.push(percent);
      hits.push(wanted.has(name));
    }
    if ([...wanted.keys()].some(name => !seen.has(name))) {
      return emptyRow(line, "unavailable", "The preview omits one or more target effects.");
    }
    const scaled = scaleWeights([...percentages, 100]);
    const full = scaled.units.pop();
    let entered = 0n;
    let favorable = 0n;
    scaled.units.forEach((units, index) => {
      entered += units;
      if (hits[index]) favorable += units;
    });
    if (entered > full) return emptyRow(line, "unavailable", "The observed effect chances on this line exceed 100%.");
    return calculated(line, favorable, full, scaled);
  }

  function compareRows(a, b) {
    const left = BigInt(a.exact.numerator) * BigInt(b.exact.denominator);
    const right = BigInt(b.exact.numerator) * BigInt(a.exact.denominator);
    return left > right ? -1 : left < right ? 1 : 0;
  }

  function summarize(rows, mode) {
    const ordered = rows.filter(row => row.status === "calculated").sort(compareRows);
    const complete = rows.length > 0 && rows.every(row => row.status !== "unavailable");
    if (complete) {
      ordered.forEach((row, index) => {
        const previous = ordered[index - 1];
        row.rank = previous && compareRows(row, previous) === 0 ? previous.rank : index + 1;
      });
    }
    return {
      status: ordered.length ? mode : "unavailable", complete, rows,
      bestLineIds: ordered.filter(row => row.rank === 1 && BigInt(row.exact.numerator) > 0n).map(row => row.lineId)
    };
  }

  function evaluate(item, mode, issue, wanted, readRow, observed) {
    const lines = Array.isArray(item?.lines) ? item.lines : [];
    const ids = new Set();
    const duplicates = new Set();
    for (const line of lines) {
      if (ids.has(line?.id)) duplicates.add(line?.id);
      ids.add(line?.id);
    }
    const rows = lines.map(line => {
      if (line?.rerollable === false) return emptyRow(line, "fixed", "This line is fixed.");
      if (!label(line?.id) || !label(line?.stat) || duplicates.has(line.id)) {
        return emptyRow(line, "unavailable", "The gear record needs a stat and a unique line identifier.");
      }
      if (observed && own(observed, line.id) && observed[line.id] === false) {
        return emptyRow(line, "fixed", "Marked as unavailable for selection in Sync.");
      }
      if (!wanted) return emptyRow(line, "unavailable", "Choose a valid target supported by this data source.");
      if (issue) return emptyRow(line, "unavailable", issue);
      if (line.rerollable !== true && !(observed && own(observed, line.id) && record(observed[line.id]))) {
        return emptyRow(line, "unavailable", "Reroll eligibility for this line is unconfirmed.");
      }
      return readRow(line);
    });
    return summarize(rows, mode);
  }

  function rankLines(item, ruleSet, targets) {
    const wanted = readTargets(targets, true);
    const issue = readRuleSet(item ?? {}, ruleSet);
    return evaluate(item, ruleSet?.status, issue, wanted, line => weightedRow(item, line, ruleSet, wanted), null);
  }

  function rankObserved(item, observations, targets) {
    const wanted = readTargets(targets, false);
    const entries = record(observations) ? observations : {};
    return evaluate(item, "observed", "", wanted,
      line => observedRow(line, own(entries, line.id) ? entries[line.id] : null, wanted), entries);
  }

  // Condition on a successful first Sync that missed every target. Only this
  // slot changes. Each miss is weighted by its chance in the original draw.
  function retryAfterMiss(item, rules, lineId, targets) {
    const wanted = readTargets(targets, false);
    const pool = rules?.retryPool;
    const table = rules?.byLine?.[lineId];
    if (!wanted || !pool || !table?.complete || table.exclude !== "none") return null;
    if (!record(pool.statWeights) || !record(pool.skillWeights) ||
        !validWeight(pool.skillShare) || pool.skillShare > 1) return null;
    const otherEffects = new Set(item.lines.filter(line => line.id !== lineId).map(line => label(line.stat)));
    const groups = [[pool.statWeights, 1 - pool.skillShare], [pool.skillWeights, pool.skillShare]];
    const availableGroups = [];
    for (const [weights, share] of groups) {
      const available = new Map();
      let total = 0, targetWeight = 0;
      for (const [name, weight] of Object.entries(weights)) {
        if (!validWeight(weight)) return null;
        const key = label(name);
        if (otherEffects.has(key)) continue;
        available.set(key, weight);
        total += weight;
        if (wanted.has(key)) targetWeight += weight;
      }
      availableGroups.push({available, share, total, targetWeight});
    }
    let missWeight = 0, weightedChance = 0;
    for (const {stat, weight} of table.outcomes) {
      const miss = label(stat);
      if (wanted.has(miss) || !weight) continue;
      if (!validWeight(weight) || !availableGroups.some(g => g.available.has(miss))) return null;
      let nextChance = 0;
      for (const group of availableGroups) {
        if (!group.share) continue;
        const remainingWeight = group.total - (group.available.get(miss) ?? 0);
        if (remainingWeight <= 0) return null;
        nextChance += group.share * group.targetWeight / remainingWeight;
      }
      weightedChance += weight * nextChance;
      missWeight += weight;
    }
    return missWeight ? weightedChance / missWeight : null;
  }

  return { rankLines, rankObserved, retryAfterMiss };
});
