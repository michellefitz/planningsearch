/**
 * Ordering a keyword search — the part that decides whether someone typing
 * their own address is shown their own house.
 */

/**
 * A house number is not a planning reference.
 *
 * Every application filed in 2022 carries "/22" in its reference, so a search
 * for "22 Rathgar Road" scored 12 for the reference on all of them against 8
 * for the address on the one house anybody meant, and the house came 13th.
 * A digit run is a house number far more often than a reference fragment, so
 * it earns a reference match at a quarter weight — enough that a bare "3952"
 * still finds its own file, not enough to outrank an address.
 */
const NUMERIC_TOKEN = /^\d{1,4}[a-z]?$/i;

/**
 * Substring matching made "22" match "2235/19", "4222/24" and "122 Rathgar
 * Road" — a house number matching a different house, which is the one
 * near-miss an address search must never make. Tokens match on a boundary
 * instead: an adjacent word character ends the match.
 */
const boundaryCache = new Map();
function boundaryRe(token) {
  let re = boundaryCache.get(token);
  if (!re) {
    re = new RegExp(
      `(?:^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
      "i"
    );
    boundaryCache.set(token, re);
  }
  return re;
}

const words = (s) => String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** A flat number is stepped over, so "Apt 4, 22 Main Street" is number 22. */
const UNIT_PREFIX = /^\s*(?:apt|apartment|unit|flat|suite)\.?\s*\d{0,4}[a-z]?\s*[,\-]?\s*/i;
const HOUSE_RUN =
  /^\s*(?:nos?\.?\s*)?(\d{1,4}[a-z]?(?:\s*(?:&|and|,|-|\/|to)\s*(?:nos?\.?\s*)?\d{1,4}[a-z]?)*)/i;

/**
 * The house numbers an address is *about*, which is not every number in it.
 *
 * "22 Rathgar Road" and "22, Rathgar Road" are number 22. "Site at Garville
 * Road, to rear of 139 Rathgar Road" is not number 139 — it is the back
 * garden, filed under its own frontage — so only a number the address opens
 * with counts. Ranges and pairs are kept whole: "77A-78", "122 & 123".
 */
export function houseNumbers(address) {
  const m = HOUSE_RUN.exec(String(address ?? "").replace(UNIT_PREFIX, ""));
  return m ? m[1].toLowerCase().match(/\d{1,4}[a-z]?/g) ?? [] : [];
}

/** Address words with any flat number stripped, so the house number leads. */
const addressWords = (address) => words(String(address ?? "").replace(UNIT_PREFIX, ""));

/**
 * The house number in a query, if it has one. "Dublin 6" and "Co. Wicklow" are
 * postal geography rather than a door, so a number the query attaches to a
 * place name is not read as one.
 */
const PLACE_NUMBER = /\b(?:dublin|co|county|d)\.?\s*$/i;

export function queryHouseNumbers(q) {
  const s = String(q ?? "");
  const out = [];
  for (const m of s.matchAll(/\b(\d{1,4}[a-z]?)\b/gi)) {
    if (PLACE_NUMBER.test(s.slice(0, m.index))) continue;
    out.push(m[1].toLowerCase());
  }
  return out;
}

/**
 * The longest run of query words appearing consecutively in the address.
 *
 * Scoring words independently cannot tell "22 Rathgar Road" from "22 Brighton
 * Road, Rathgar" — both carry every word of the query, and with the street
 * name on every candidate there is nothing left to separate them. Adjacency
 * can: only one of them says "22 rathgar road".
 */
function longestRun(qw, aw) {
  let best = 0;
  let atStart = false;
  for (let i = 0; i < qw.length; i++) {
    for (let j = 0; j < aw.length; j++) {
      let k = 0;
      while (i + k < qw.length && j + k < aw.length && qw[i + k] === aw[j + k]) k += 1;
      if (k > best) {
        best = k;
        atStart = j === 0;
      }
    }
  }
  return { run: best, atStart };
}

/**
 * How much one token is worth for telling these rows apart.
 *
 * Searching the geocoded suggestion "22 Rathgar Road, Dublin 6" returned 59
 * rows and put the house nowhere in the first fifteen, because "rathgar",
 * "road", "dublin" and "6" sit on nearly every one of them and each scored the
 * same 8 as "22". A token every candidate carries separates none of them. This
 * is the inverse document frequency the BM25 backend applies and this scorer
 * dropped — floored rather than zeroed, so a common token still breaks a tie
 * between a row that has it and a row that does not.
 */
export function idfOver(rows, tokens, textOf) {
  const idf = new Map();
  for (const t of tokens) {
    const re = boundaryRe(t);
    let df = 0;
    for (const row of rows) if (re.test(textOf(row))) df += 1;
    idf.set(t, Math.max(0.08, Math.log((rows.length + 1) / (df + 1))));
  }
  return idf;
}

/**
 * Field-weighted relevance: a reference match beats an address match, which
 * beats an applicant, which beats a passing mention in the description.
 * Mirrors the BM25 column weights the SQLite backend uses — without it, exact
 * matches came back in bundle order, so a road-name search was arbitrary.
 */
export function relevanceScore(app, tokens, idf, wanted) {
  const reference = String(app.planning_reference ?? "").toLowerCase();
  const address = String(app.address_text ?? "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const numeric = NUMERIC_TOKEN.test(t);
    const re = boundaryRe(t);
    const weight = idf?.get(t) ?? 1;
    // Ordered by what the token is worth in each field, so a numeric token is
    // credited to the address rather than to the reference it also happens to
    // appear in — "22" in "22 Rathgar Road" outweighs "22" in "4034/22".
    const fields = numeric
      ? [[address, 8], [reference, 3], [String(app.applicant_name ?? "").toLowerCase(), 4],
         [String(app.description ?? "").toLowerCase(), 1]]
      : [[reference, 12], [address, 8], [String(app.applicant_name ?? "").toLowerCase(), 4],
         [String(app.description ?? "").toLowerCase(), 1]];
    for (const [text, fieldWeight] of fields) {
      if (re.test(text) || (!numeric && text.includes(t))) {
        score += fieldWeight * weight;
        break; // strongest field wins for this token
      }
    }
  }

  if (tokens.length > 1) {
    const aw = addressWords(app.address_text);
    const { run, atStart } = longestRun(tokens, aw);
    // Two words of the query running together in the address is the street;
    // three is the street and the number.
    if (run > 1) score += 12 * run;
    // The strongest signal an address search has: this application is filed at
    // the number that was typed, on the street that was typed.
    if (run > 1 && atStart && wanted?.length) {
      const at = houseNumbers(app.address_text);
      if (at.some((n) => wanted.includes(n))) score += 40;
    }
  }
  return score;
}
