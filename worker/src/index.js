// Trip Planner API — generates a recommended trip itinerary as HTML using Claude,
// mirroring the "trip-plan-추천형" style (day tabs, timed cards, food/activity color coding).
// Also supports opt-in publishing of a finished plan to GitHub Pages.
//
// POST /generate  { destination, startDate, endDate, companions: [{gender, age}], budget, interestCategories, interestOther, language }
// -> 200 text/html  (the finished itinerary page, written entirely in the requested language)
//
// POST /save  { html }
// -> 200 json { url }  (pushes the given HTML into the GITHUB_REPO's /plans folder and returns its Pages URL)
//
// All error responses are JSON and carry CORS headers.

const MODEL = "claude-sonnet-5"; // Haiku 4.5 was unreliable at following the destination/structure instructions in testing; Sonnet costs more per call but the per-IP daily cap bounds worst-case spend
const MAX_SAVE_HTML_BYTES = 300_000; // generous headroom over a normal generated plan; blocks abuse of /save as free file storage

const LANGUAGES = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
};

const GENDER_LABELS = {
  male: "male",
  female: "female",
  neutral: "prefers not to specify gender",
};

const CATEGORY_LABELS = {
  food: "restaurants/local food",
  cafe: "cafes",
  nature: "nature/relaxation",
  activity: "activities/experiences",
  culture: "culture/history",
  shopping: "shopping",
  nightview: "night views/photo spots",
  kids: "kid-friendly",
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// Clamp free-text fields so a malicious caller can't blow up token usage or smuggle
// an oversized prompt through the form.
function clamp(str, max) {
  if (typeof str !== "string") return "";
  return str.slice(0, max).trim();
}

// Shared IP+day bucket, namespaced per action so /generate (expensive, Claude call) and
// /save (cheap, GitHub API call) don't eat into each other's quota.
async function checkAndBumpRateLimit(action, ip, env) {
  const today = new Date().toISOString().slice(0, 10); // UTC day bucket, good enough for abuse control
  const key = `${action}:${ip}:${today}`;
  const limit = parseInt(env.DAILY_LIMIT_PER_IP || "5", 10);

  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= limit) return false;

  // 26h TTL so the bucket always outlives the UTC day it was created in, then expires on its own.
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 26 * 60 * 60 });
  return true;
}

function buildSystemPrompt(languageName, langCode) {
  return `You are a travel planner. Given a destination, date range, companions (with gender and age), budget level, and interests, write ONE complete, opinionated, day-by-day recommended itinerary — not a menu of options. Make the concrete calls (which cafe, what order, when to eat) the way a knowledgeable local friend would, and tailor suggestions to the companions' ages (e.g. a 5-year-old and a 70-year-old both traveling means less walking, earlier meals, more rest stops — say so explicitly where it matters).

Write EVERY piece of visible text in the output — title, headings, card contents, notes, footer — entirely in ${languageName}. This is a hard requirement regardless of what language this prompt is written in.

Output ONLY a single complete HTML document (starting with <!doctype html>, nothing before or after it — no markdown fences, no commentary). Use exactly this structure and CSS so the result matches the site's existing design language:

<!doctype html>
<html lang="${langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>[trip title]</title>
<style>
body{margin:0;font-family:Arial,'Noto Sans KR',sans-serif;background:#f3f7f9;color:#263238}
header{background:linear-gradient(135deg,#123b52,#1e7898);color:white;padding:48px 0 32px;text-align:center}
.wrap{max-width:920px;margin:auto;padding:0 18px}
h1{font-size:34px;margin:24px 0 6px}
h2{color:#123b52;margin-top:36px}
.sub{opacity:.9}
.tabs{display:flex;gap:8px;position:sticky;top:0;background:#f3f7f9;padding:10px 0;z-index:5;flex-wrap:wrap}
.tabs a{text-decoration:none;background:white;color:#1e7898;padding:10px 14px;border-radius:999px;box-shadow:0 2px 10px #0001}
.card{display:grid;grid-template-columns:120px 1fr;background:white;margin:10px 0;border-radius:14px;padding:16px;box-shadow:0 4px 18px #0000000c}
.time{font-weight:700;color:#123b52;font-variant-numeric:tabular-nums}
.card.alt{background:#ddf3fa}
.card.food{background:#fff4dc}
.note{background:#fff4dc;border-left:5px solid #f47c67;padding:16px;border-radius:8px;margin:20px 0}
footer{padding:40px 0;color:#6d7880;font-size:13px}
@media(max-width:600px){h1{font-size:27px}.card{grid-template-columns:1fr}.time{margin-bottom:6px}}
</style>
</head>
<body>
<header class="wrap"><h1>[title]</h1><p class="sub">[one-line subtitle reflecting who's traveling]</p></header>
<div class="wrap">
<nav class="tabs">[one <a href="#dN">DAY N</a> per day]</nav>
<main>
[one <section> per day: <h2 id="dN">DAY N — [theme]</h2> then several .card / .card.alt / .card.food divs, each with a .time div and a bold place + one short sentence, then a closing .note div with a concrete fallback plan for that day]
</main>
<footer>[practical caveats that age fast: hours, prices, weather-dependence — "여행 전날 다시 확인" spirit. No fabricated photo credits since no header photo is used.]</footer>
</div>
</body>
</html>

Rules:
- No header <img>, no base64 images — the header is the CSS gradient only. Never invent an image URL.
- Don't invent specific restaurant/business names you're not reasonably confident exist; when unsure, describe the category instead (translated into ${languageName}, e.g. "an ocean-view cafe").
- Card class: plain "card" for transit/logistics, "card alt" for sightseeing/activities, "card food" for meals — use the color coding consistently.
- Match the number of days requested exactly — one tab and one <section> per day.
- Output nothing but the HTML document.`;
}

async function generateItinerary(input, env) {
  const languageName = LANGUAGES[input.language] || LANGUAGES.ko;
  const companionsDesc = input.companions
    .map((c) => `${GENDER_LABELS[c.gender] || "unspecified gender"}, age ${c.age}`)
    .join("; ");
  const interestsDesc = [
    ...input.interestCategories.map((c) => CATEGORY_LABELS[c] || c),
    input.interestOther,
  ]
    .filter(Boolean)
    .join(", ");

  const userPrompt = `Destination: ${input.destination}
Dates: ${input.startDate} to ${input.endDate} (${input.days} day${input.days > 1 ? "s" : ""})
Companions (${input.companions.length}): ${companionsDesc}
Budget level: ${input.budget}
Interests: ${interestsDesc || "no strong preference, keep the pace comfortable"}
Output language: ${languageName}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: buildSystemPrompt(languageName, input.language),
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  let html = (textBlock?.text || "").trim();

  // Models sometimes wrap the answer in a ```html fence despite instructions not to —
  // strip that instead of failing outright.
  if (html.startsWith("```")) {
    html = html.replace(/^```[a-zA-Z]*\n/, "").replace(/```\s*$/, "").trim();
  }

  const doctypeIndex = html.search(/<!doctype html/i);
  if (doctypeIndex === -1) {
    throw new Error(`Model did not return an HTML document (got: ${html.slice(0, 200)})`);
  }
  return html.slice(doctypeIndex);
}

// Fire-and-forget log of one /generate call to a Google Sheet via an Apps Script Web App
// (see google-apps-script.gs). Never throws — a logging failure must not break the
// user-facing response, so errors just go to the Worker's own console/tail output.
async function logToSheet(entry, env) {
  if (!env.SHEETS_WEBHOOK_URL) return; // logging not configured yet, skip quietly
  try {
    await fetch(env.SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.SHEETS_SECRET, ...entry }),
    });
  } catch (err) {
    console.error("Sheets logging failed:", err.message);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Pushes one HTML file into GITHUB_REPO's /plans folder via the GitHub Contents API
// and returns the GitHub Pages URL it will be served at once Pages rebuilds.
async function saveToGithub(html, env) {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const randomId = crypto.randomUUID().slice(0, 8);
  const path = `plans/${datePart}-${randomId}.html`;

  const contentBase64 = bytesToBase64(new TextEncoder().encode(html));

  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "trip-planner-api",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: `Save generated plan ${path}`,
        content: contentBase64,
        branch: "main",
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 300)}`);
  }

  return `https://${env.GITHUB_OWNER}.github.io/${env.GITHUB_REPO}/${path}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function handleGenerate(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, env);
  }

  const destination = clamp(body.destination, 100);
  const startDate = clamp(body.startDate, 10);
  const endDate = clamp(body.endDate, 10);
  const budget = clamp(body.budget, 20);
  const language = clamp(body.language, 5);
  const interestOther = clamp(body.interestOther, 200);
  const interestCategories = Array.isArray(body.interestCategories)
    ? body.interestCategories.filter((c) => typeof c === "string" && CATEGORY_LABELS[c]).slice(0, 20)
    : [];
  const companions = Array.isArray(body.companions)
    ? body.companions.slice(0, 10).map((c) => ({
        gender: GENDER_LABELS[c?.gender] ? c.gender : "neutral",
        age: parseInt(c?.age, 10),
      }))
    : [];

  if (!destination) return jsonError("destination is required", 400, env);
  if (!LANGUAGES[language]) return jsonError("language must be one of ko, en, ja", 400, env);
  if (!budget) return jsonError("budget is required", 400, env);

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (isNaN(start) || isNaN(end) || end < start) {
    return jsonError("startDate/endDate must be a valid range", 400, env);
  }
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > 10) return jsonError("trip length must be 10 days or fewer", 400, env);

  if (companions.length < 1 || companions.some((c) => !Number.isInteger(c.age) || c.age < 0 || c.age > 120)) {
    return jsonError("companions must be a non-empty list with a valid age each", 400, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await checkAndBumpRateLimit("generate", ip, env);
  if (!allowed) {
    return jsonError(
      `Daily request limit (${env.DAILY_LIMIT_PER_IP || 5}) reached. Please try again tomorrow.`,
      429,
      env
    );
  }

  try {
    const html = await generateItinerary(
      { destination, startDate, endDate, days, companions, budget, interestCategories, interestOther, language },
      env
    );

    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    ctx.waitUntil(
      logToSheet(
        {
          timestamp: Date.now(),
          destination,
          startDate,
          endDate,
          days,
          companions: companions.map((c) => `${c.gender}/${c.age}`).join(", "),
          budget,
          interests: [...interestCategories, interestOther].filter(Boolean).join(", "),
          language,
          resultTitle: titleMatch ? titleMatch[1] : "",
        },
        env
      )
    );

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders(env) },
    });
  } catch (err) {
    return jsonError(`Generation failed: ${err.message}`, 502, env);
  }
}

async function handleSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, env);
  }

  const html = typeof body.html === "string" ? body.html.trim() : "";
  if (!html) return jsonError("html is required", 400, env);
  if (new TextEncoder().encode(html).length > MAX_SAVE_HTML_BYTES) {
    return jsonError("html is too large", 400, env);
  }
  if (!/^<!doctype html/i.test(html)) {
    return jsonError("html must be a full HTML document", 400, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await checkAndBumpRateLimit("save", ip, env);
  if (!allowed) {
    return jsonError(
      `오늘 저장 한도(하루 ${env.DAILY_LIMIT_PER_IP || 5}회)를 초과했어요. 내일 다시 시도해주세요.`,
      429,
      env
    );
  }

  try {
    const url = await saveToGithub(html, env);
    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(env) },
    });
  } catch (err) {
    return jsonError(`저장에 실패했어요: ${err.message}`, 502, env);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    if (request.method !== "POST") return jsonError("Not found", 404, env);

    if (url.pathname === "/generate") return handleGenerate(request, env, ctx);
    if (url.pathname === "/save") return handleSave(request, env);
    return jsonError("Not found", 404, env);
  },
};
