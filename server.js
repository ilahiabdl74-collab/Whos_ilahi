// Instagram comment auto-reply backend (Node 18+)
// Install: npm i express
// Run:     node server.js
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");

const {
  VERIFY_TOKEN,       // any secret text you choose; same value goes in Meta webhook setup
  APP_SECRET,         // Meta app secret (for signature check)
  PAGE_ACCESS_TOKEN,  // long-lived token with instagram_manage_comments + instagram_manage_messages
  PORT = 3000,
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0"; // check Meta docs for the latest version

// ---------- RULES (edit rules.json, or build the dashboard on top of it) ----------
// mode "keyword": reply only if comment contains one of the keywords
// mode "any":     reply to every comment
// mediaId "*" = all reels
// limits: perHour / perDay (0 = unlimited), oncePerUser, delaySec (min..max random wait)
const RULES_FILE = "rules.json";
const defaultRules = [
  {
    mediaId: "*",
    mode: "keyword",
    keywords: ["link", "price"],
    publicReplies: ["Check your DM 📩", "DM anuppiruken 🙌"],
    dmText: "Thanks for commenting! Here is the link: https://example.com",
    sendPublic: true,
    sendDm: true,
    limits: { perHour: 30, perDay: 200, oncePerUser: true, delaySec: [5, 20] },
  },
];
if (!fs.existsSync(RULES_FILE)) fs.writeFileSync(RULES_FILE, JSON.stringify(defaultRules, null, 2));
const loadRules = () => JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));

// ---------- STATE (simple file log; use a database later) ----------
const LOG_FILE = "log.json";
const log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) : [];
const saveLog = () => fs.writeFileSync(LOG_FILE, JSON.stringify(log));

function withinLimits(rule, userId) {
  const now = Date.now();
  const mine = log.filter((l) => l.rule === rule.mediaId + rule.mode);
  const { perHour = 0, perDay = 0, oncePerUser = false } = rule.limits || {};
  if (perHour && mine.filter((l) => now - l.t < 3600e3).length >= perHour) return false;
  if (perDay && mine.filter((l) => now - l.t < 86400e3).length >= perDay) return false;
  if (oncePerUser && mine.some((l) => l.user === userId)) return false;
  return true;
}

function matches(rule, text) {
  if (rule.mediaId !== "*" && rule.mediaId !== text.mediaId) return false;
  if (rule.mode === "any") return true;
  const t = text.body.toLowerCase();
  return (rule.keywords || []).some((k) => t.includes(k.toLowerCase()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function graphPost(path, body) {
  const res = await fetch(`${GRAPH}${path}?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error("Graph error:", JSON.stringify(data));
  return data;
}

async function handleComment({ id, text, from, media }) {
  const info = { body: text || "", mediaId: media && media.id };
  for (const rule of loadRules()) {
    if (!matches(rule, info)) continue;
    if (!withinLimits(rule, from.id)) { console.log("Limit reached, skipped", id); return; }

    const [min, max] = (rule.limits && rule.limits.delaySec) || [0, 0];
    await sleep((min + Math.random() * (max - min)) * 1000);

    if (rule.sendPublic && rule.publicReplies.length)
      await graphPost(`/${id}/replies`, { message: pick(rule.publicReplies) });
    if (rule.sendDm)
      await graphPost(`/me/messages`, { recipient: { comment_id: id }, message: { text: rule.dmText } });

    log.push({ t: Date.now(), user: from.id, comment: id, rule: rule.mediaId + rule.mode });
    saveLog();
    return; // first matching rule wins
  }
}

// ---------- SERVER ----------
const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// Meta calls this once when you set up the webhook
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

// Meta sends every new comment here
app.post("/webhook", (req, res) => {
  const sig = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.sendStatus(401);

  res.sendStatus(200); // answer fast, process after
  for (const entry of req.body.entry || [])
    for (const ch of entry.changes || [])
      if (ch.field === "comments" && ch.value && ch.value.from && ch.value.from.id !== entry.id)
        handleComment(ch.value).catch((e) => console.error(e));
});

// ---------- DASHBOARD API (password protected) ----------
const { ADMIN_PASSWORD } = process.env;
const auth = (req, res, next) =>
  ADMIN_PASSWORD && req.get("x-admin-password") === ADMIN_PASSWORD ? next() : res.sendStatus(401);

app.get("/", (_req, res) => res.sendFile(__dirname + "/dashboard.html"));
app.get("/api/rules", auth, (_req, res) => res.json(loadRules()));
app.put("/api/rules", auth, (req, res) => {
  if (!Array.isArray(req.body)) return res.sendStatus(400);
  fs.writeFileSync(RULES_FILE, JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
app.get("/api/stats", auth, (_req, res) => {
  const now = Date.now();
  res.json({
    hour: log.filter((l) => now - l.t < 3600e3).length,
    day: log.filter((l) => now - l.t < 86400e3).length,
    total: log.length,
    recent: log.slice(-10).reverse(),
  });
});

app.listen(PORT, () => console.log("Listening on", PORT));
