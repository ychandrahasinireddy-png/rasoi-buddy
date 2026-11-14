// Rasoi Buddy's server side: a Vercel serverless function at /api/chat.
// It keeps the Gemini API key secret, holds the prompts, and only does
// Rasoi Buddy's three jobs, so nobody can use it as a free general AI.

// Models to try, in order. The first is used normally; the others are backups
// in case one is busy (503), rate-limited (429), missing (404) or too slow.
const MODELS = [...new Set([
  process.env.GEMINI_MODEL,      // whatever you set in Vercel (optional)
  'gemini-3.5-flash-lite',       // fast, thinking off by default
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite'
].filter(Boolean))];

const TIMEOUT_MS = 20000;        // give up on one model after 20 seconds and try the next

const PERSONA = `You are Rasoi Buddy, a warm, casual, slightly playful cooking companion for people who can't cook or can't decide what to cook. You talk like a friendly Indian foodie friend: short sentences, light humour, the odd emoji, never preachy. You know Indian regional cooking (Andhra, Kerala, North Indian, Chettinad etc.) and world cuisines well, and you suggest dishes that match the person's skill level, time and diet honestly. Assume a typical Indian home kitchen unless told otherwise. Only talk about food and cooking; if asked about anything else, steer back to food in a friendly way. Food allergies are serious: if the person listed allergies or foods to avoid, NEVER suggest or include them, including hidden sources (e.g. peanuts or cashews in chutneys and gravies, ghee/butter/curd/paneer for dairy, rava/maida/atta/soy sauce for gluten, fish sauce for fish).`;

// ---- simple limit: max 30 AI calls per visitor every 10 minutes (best effort) ----
const hits = new Map();
function tooMany(ip){
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now); hits.set(ip, list);
  return list.length > 30;
}

const cap = (v, n) => String(v ?? '').slice(0, n);

function context(body){
  const prefs = Object.entries(body.prefs || {}).slice(0, 8)
    .map(([k, v]) => `${cap(k, 20)}: ${cap(v, 300)}`).join('; ') || 'nothing chosen yet';
  const shown = (body.shown || []).slice(-40).map(x => cap(x, 60)).join(', ') || 'none';
  const convo = (body.history || []).slice(-14)
    .map(m => `${m.role === 'user' ? 'User' : 'Buddy'}: ${cap(m.content, 500)}`).join('\n');
  return `What we know so far: ${prefs}.\nDishes already suggested: ${shown}.\n\nConversation so far:\n${convo}`;
}

const DISH = `{"name": "...", "why": "one short sentence on why it fits", "time": "e.g. 25 min", "level": "Easy|Medium|Bit of a project", "wiki": "exact title of the English Wikipedia article about this dish if you are sure one exists, otherwise null"}`;

function buildPrompt(body){
  const ctx = context(body);
  if (body.type === 'suggest') return {json: true, prompt:
`${PERSONA}

${ctx}

Task: suggest 6 ${body.more ? 'NEW (not already suggested) ' : ''}dishes that fit everything above. Give real variety: mix well-known favourites with a couple of lesser-known regional or home-style dishes, and vary the type (rice, curry, dry side, one-pot, snack-style). Be realistic about the skill level and time. If they told you what's in their kitchen, this matters most: build the dishes around those ingredients. At least 4 of the 6 must be cookable with only what they listed plus basic pantry items; the rest may need at most 1 or 2 extra things, which you must name in "why" (e.g. "just grab some coriander"). In "why", mention which of their ingredients the dish uses. If an ingredient doesn't suit the chosen cuisine, adapt the dish sensibly rather than ignoring what they have. Assume salt, oil and basic spices are always there. If they listed allergies (anything other than "none"), every dish must be completely free of them: prefer dishes that are naturally free of them, or adapt a dish and say "made without ..." in "why".
Reply as JSON: {"reply": "one short friendly line introducing the 6 picks", "dishes": [${DISH}]}`};

  if (body.type === 'recipe') return {json: false, prompt:
`${PERSONA}

${ctx}

Task: give a recipe for "${cap(body.dish, 80)}" for 2 people, written for this person's skill level (if they're a beginner, explain things like "until the oil shimmers" or "till the raw smell goes"). Format in plain markdown:
A one-line friendly intro.
**Ingredients**
- item with quantity
**Steps**
1. step
**Buddy tip**
One tip that saves beginners from a common mistake.
Mark any ingredient they probably don't have (based on their kitchen list; salt, oil and basic spices count as available) with "(buy)". If they listed allergies, the recipe must not contain them in any form: if the classic version uses one, use a safe substitute and say so, and end with one short line reminding them to check labels on packaged ingredients. Keep it tight, no extra headings.`};

  if (body.type === 'chat') return {json: true, prompt:
`${PERSONA}

${ctx}

The user just typed something freely (it's the last User line above). Reply naturally as Buddy. If they list ingredients, a craving, a constraint or a change of mind, update your thinking and suggest 4 to 6 dishes. If they ask for a recipe of a specific dish, set recipe_for. If they're just chatting, chat back briefly and steer gently towards deciding what to cook.
Reply as JSON: {"reply": "your message (markdown ok, keep it short)", "dishes": [${DISH}] or [], "recipe_for": "dish name" or null, "chips": ["up to 4 short quick-reply options"] or [], "prefs": {"mood"?: "...", "cuisine"?: "...", "diet"?: "...", "allergies"?: "comma-separated list, merged with any they told you before", "time"?: "...", "skill"?: "..."} only for things the user just told you}`};

  return null;
}

// Ask one model. Returns {ok, text} or {ok:false, status, detail}.
async function askGemini(model, key, built, withThinking = true){
  const generationConfig = {
    temperature: built.json ? 0.9 : 0.8,
    maxOutputTokens: 2048
  };
  if (built.json) generationConfig.responseMimeType = 'application/json';
  // keep "thinking" to a minimum so answers come back in seconds
  if (withThinking) generationConfig.thinkingConfig = {thinkingLevel: 'minimal'};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
      body: JSON.stringify({contents: [{role: 'user', parts: [{text: built.prompt}]}], generationConfig})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok){
      const detail = JSON.stringify(data).slice(0, 300);
      // some models don't accept the thinking setting: retry once without it
      if (r.status === 400 && withThinking && /thinking/i.test(detail)) return askGemini(model, key, built, false);
      return {ok: false, status: r.status, detail};
    }
    const text = (data.candidates?.[0]?.content?.parts || [])
      .filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text) return {ok: false, status: 502, detail: 'empty answer'};
    return {ok: true, text};
  } catch (e){
    return {ok: false, status: e.name === 'AbortError' ? 504 : 502, detail: String(e)};
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error: 'Use POST'});
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({error: 'GEMINI_API_KEY is not set on the server'});

  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (tooMany(ip)) return res.status(429).json({error: 'Too many requests, try again in a few minutes'});

  let body = req.body;
  if (typeof body === 'string'){ try { body = JSON.parse(body); } catch { body = null; } }
  const built = body && buildPrompt(body);
  if (!built) return res.status(400).json({error: 'Unknown request'});

  let lastStatus = 0;
  for (const model of MODELS){
    const result = await askGemini(model, key, built);
    if (result.ok){
      const text = result.text;
      if (!built.json) return res.status(200).json({text});
      try {
        const m = text.match(/\{[\s\S]*\}/);
        return res.status(200).json({data: JSON.parse(m ? m[0] : text)});
      } catch (e){
        console.error('Bad JSON from', model, text.slice(0, 300));
        lastStatus = 502; continue;            // try the next model
      }
    }
    lastStatus = result.status;
    console.error('Gemini error', model, result.status, result.detail);
  }
  if (lastStatus === 429) return res.status(429).json({error: 'AI is busy, try again shortly'});
  return res.status(502).json({error: 'The AI had a problem answering'});
};
