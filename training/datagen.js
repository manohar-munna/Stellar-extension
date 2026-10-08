// Generates fine-tuning data for the on-device model by letting Gemini (the
// teacher) run many varied tasks through the real extension, recording every
// step, and verifying each episode against ground truth.
//
//   npm i puppeteer                       (once, anywhere on NODE_PATH)
//   node training/datagen.js --episodes 40 --wiki 8 --out training/data
//
// Needs GEMINI_API_KEYS in the repo's .env. Output: a dataset zip (see
// sidepanel/training.js) plus a JSON log of every episode.

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
);
const EPISODES = +(args.episodes || 40);
const WIKI = +(args.wiki || 8);
const OUT = path.resolve(ROOT, args.out || "training/data");
const SEED = +(args.seed || 7);
fs.mkdirSync(OUT, { recursive: true });

const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const KEYS = (env.match(/^\s*GEMINI_API_KEYS\s*=\s*(.+)$/m) || [])[1]?.replace(/["']/g, "").trim();
if (!KEYS) throw new Error("GEMINI_API_KEYS missing in .env");

// ------------------------------------------------------------ randomness
let rs = SEED;
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => a.map((x) => [rnd(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------ fake people
const FIRST = ["Aarav", "Priya", "Rohan", "Ananya", "Vikram", "Meera", "Kabir", "Isha", "Arjun", "Diya", "Neel", "Sara", "Dev", "Tara", "Karan", "Nisha", "Omar", "Leela", "Ravi", "Zoya"];
const LAST = ["Sharma", "Iyer", "Mehta", "Reddy", "Nair", "Kapoor", "Das", "Khan", "Joshi", "Bose", "Menon", "Gupta", "Singh", "Rao", "Pillai"];
const CITIES = [["Bengaluru", "560025", "Karnataka"], ["Chennai", "600028", "Tamil Nadu"], ["Pune", "411001", "Maharashtra"], ["Kolkata", "700016", "West Bengal"], ["Hyderabad", "500081", "Telangana"], ["Jaipur", "302001", "Rajasthan"]];
const STREETS = ["Residency Road", "Lake View Road", "MG Road", "Park Street", "Hill Road", "Church Street", "Ring Road"];
const COMPANIES = ["Nimbus Analytics", "Orbit Labs", "Kite Systems", "Banyan Health", "Quill Software"];
const TITLES = ["Data Engineer", "Product Designer", "QA Analyst", "Backend Developer", "Support Lead"];

function person() {
  const first = pick(FIRST);
  const last = pick(LAST);
  const [city, pin, state] = pick(CITIES);
  return {
    NAME: `${first} ${last}`,
    EMAIL: `${first}.${last}${Math.floor(rnd() * 90 + 10)}@example.${pick(["com", "org", "net"])}`.toLowerCase(),
    PHONE: `+91 9${Math.floor(rnd() * 9000 + 1000)} ${Math.floor(rnd() * 90000 + 10000)}`,
    ADDRESS: `${Math.floor(rnd() * 98 + 1)} ${pick(STREETS)}`,
    CITY: city,
    PINCODE: pin,
    STATE: state,
    DOB: `${String(Math.floor(rnd() * 27 + 1)).padStart(2, "0")}/${String(Math.floor(rnd() * 12 + 1)).padStart(2, "0")}/${Math.floor(rnd() * 25 + 1975)}`,
    COMPANY: pick(COMPANIES),
    JOB_TITLE: pick(TITLES),
  };
}

// ------------------------------------------------------------ page parts
const LABELS = {
  NAME: ["Full name", "Your name", "Name", "Applicant name", "Name on account"],
  EMAIL: ["Email", "Email address", "Reply-to email", "Work email", "E-mail"],
  PHONE: ["Phone", "Mobile number", "Phone number", "Contact number"],
  ADDRESS: ["Address", "Street address", "Address line 1"],
  CITY: ["City", "Town / City"],
  PINCODE: ["PIN code", "Postal code", "ZIP / PIN"],
  DOB: ["Date of birth", "DOB (dd/mm/yyyy)"],
  COMPANY: ["Current company", "Company"],
  JOB_TITLE: ["Current role", "Job title"],
};

function decoys() {
  const nav = shuffle(["Dashboard", "Projects", "Billing", "Support", "Docs", "Pricing", "Blog"]).slice(0, 4);
  const extra = shuffle([
    '<button type="button" class="danger" onclick="this.textContent=\'Account deleted?\'">Delete account</button>',
    '<button type="button" onclick="1">Sign out</button>',
    '<a href="#" onclick="return false">Privacy policy</a>',
    '<button type="button" onclick="1">Download invoice</button>',
  ]).slice(0, 2);
  return { nav, extra };
}

function profileCard(p) {
  // On-page PII so redaction appears in the frames.
  return `<section class="card"><h3>Your profile</h3><dl><dt>Name</dt><dd>${esc(p.NAME)}</dd><dt>Email</dt><dd>${esc(p.EMAIL)}</dd><dt>Phone</dt><dd>${esc(p.PHONE)}</dd><dt>API key</dt><dd class="mono">sk-live-${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}</dd></dl></section>`;
}

function page({ title, brand, formHtml, p, layout }) {
  const { nav, extra } = decoys();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;font:14px/1.5 system-ui,Segoe UI,sans-serif;background:${pick(["#f6f7fb", "#fafaf7", "#f3f6f4"])};color:#172033}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 24px;background:#fff;border-bottom:1px solid #e4e7ec}
nav a{margin:0 9px;color:#667085;text-decoration:none}.logo{font-weight:800;color:${pick(["#4f46e5", "#0f766e", "#b45309", "#be123c"])}}
main{max-width:1000px;margin:20px auto;padding:0 18px;display:grid;grid-template-columns:${layout === 2 ? "1fr 1.3fr" : "1fr"};gap:16px}
.card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px 18px}dl{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;margin:0}dt{color:#667085}dd{margin:0}.mono{font-family:Consolas,monospace}
label{display:block;margin:9px 0 3px;font-weight:600;font-size:13px}input,select,textarea{width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid #d0d5dd;border-radius:8px;font:inherit}
input[type=checkbox]{width:auto}.agree{display:flex;gap:8px;align-items:center;font-weight:400}
button{margin-top:12px;padding:8px 15px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}button.danger{background:#fee2e2;color:#b91c1c}button[type=button]{background:#eef2ff;color:#4f46e5}
#done{display:none;padding:10px 12px;background:#ecfdf5;border-radius:8px;margin-top:10px}
</style></head><body><header><span class="logo">◎ ${esc(brand)}</span><nav>${nav.map((n) => `<a href="#" onclick="return false">${n}</a>`).join("")}</nav><span>${esc(p.NAME)}</span></header>
<main>${layout === 2 ? profileCard(p) : ""}<section class="card">${formHtml}<div>${extra.join(" ")}</div><div id="done">Submitted ✓</div></section>${layout === 1 && rnd() < 0.5 ? profileCard(p) : ""}</main>
<script>
document.querySelectorAll("form").forEach((f) => f.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = {};
  for (const el of f.elements) if (el.name) data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  document.body.dataset.submitted = JSON.stringify(data);
  document.getElementById("done").style.display = "block";
}));
</script></body></html>`;
}

const field = (key, p, id) => {
  const label = pick(LABELS[key]);
  return { key, html: `<label for="${id}">${label}</label><input id="${id}" name="${key}" autocomplete="off">` };
};

// ------------------------------------------------------------ templates
const TEMPLATES = {
  support(p) {
    const topics = shuffle(["Billing", "Account access", "Bug report", "Feature request", "General question"]);
    const topic = pick(topics.filter((t) => t !== "General question"));
    const ask = pick([
      ["downgrade my plan", ["downgrade"]],
      ["get a refund for last month", ["refund"]],
      ["reset my two-factor authentication", ["two-factor", "2fa", "authentication"]],
      ["report that the export button is broken", ["export", "broken"]],
      ["add a dark mode", ["dark mode"]],
    ]);
    const fields = shuffle([field("NAME", p, "f1"), field("EMAIL", p, "f2")]);
    const form = `<h2>${pick(["Contact support", "Open a ticket", "Help desk"])}</h2><form>${fields.map((f) => f.html).join("")}
<label for="topic">${pick(["Topic", "Category", "Issue type"])}</label><select id="topic" name="topic">${["General question", ...topics.filter((t) => t !== "General question")].map((t) => `<option>${t}</option>`).join("")}</select>
<label for="msg">${pick(["Message", "Describe the issue", "Details"])}</label><textarea id="msg" name="message" rows="3"></textarea>
<button type="submit">${pick(["Send message", "Submit ticket", "Send"])}</button></form>`;
    return {
      kind: "support",
      html: page({ title: "Support", brand: pick(["Orbit Cloud", "Kite", "Nimbus"]), formHtml: form, p, layout: pick([1, 2]) }),
      task: `Open a ${topic} support ticket using my vault name and email, asking to ${ask[0]}, and send it.`,
      check: (d) => d.NAME === p.NAME && d.EMAIL === p.EMAIL && d.topic === topic && ask[1].some((k) => (d.message || "").toLowerCase().includes(k)),
    };
  },
  signup(p) {
    const keys = shuffle(["NAME", "EMAIL", "PHONE", ...(rnd() < 0.5 ? ["DOB"] : [])]);
    const fields = keys.map((k, i) => field(k, p, `s${i}`));
    const plan = pick(["Free", "Pro", "Team"]);
    const form = `<h2>${pick(["Create your account", "Sign up", "Join us"])}</h2><form>${fields.map((f) => f.html).join("")}
<label for="plan">Plan</label><select id="plan" name="plan"><option>Free</option><option>Pro</option><option>Team</option></select>
<label class="agree"><input type="checkbox" name="agree" id="agree"> I agree to the terms of service</label>
<button type="submit">${pick(["Create account", "Sign up", "Register"])}</button></form>`;
    return {
      kind: "signup",
      html: page({ title: "Sign up", brand: pick(["Quill", "Banyan", "Orbit"]), formHtml: form, p, layout: 1 }),
      task: `Sign me up for the ${plan} plan using my vault details, accept the terms, and create the account.`,
      check: (d) => keys.every((k) => d[k] === p[k]) && d.plan === plan && d.agree === true,
    };
  },
  shipping(p) {
    const keys = shuffle(["NAME", "PHONE", "ADDRESS", "CITY", "PINCODE"]);
    const fields = keys.map((k, i) => field(k, p, `a${i}`));
    const speed = pick(["Standard", "Express"]);
    const form = `<h2>${pick(["Shipping address", "Delivery details", "Where should we deliver?"])}</h2><form>${fields.map((f) => f.html).join("")}
<label for="speed">Delivery speed</label><select id="speed" name="speed"><option>Standard</option><option>Express</option></select>
<button type="submit">${pick(["Continue to payment", "Save address", "Continue"])}</button></form>`;
    return {
      kind: "shipping",
      html: page({ title: "Checkout", brand: pick(["Basket", "Cartly", "Shopwise"]), formHtml: form, p, layout: pick([1, 2]) }),
      task: `Fill the shipping form with my vault details, choose ${speed} delivery, and continue.`,
      check: (d) => keys.every((k) => d[k] === p[k]) && d.speed === speed,
    };
  },
  job(p) {
    const role = pick(["Data Engineer", "Frontend Developer", "Product Manager", "QA Engineer"]);
    const keys = shuffle(["NAME", "EMAIL", "PHONE", ...(rnd() < 0.6 ? ["COMPANY"] : [])]);
    const fields = keys.map((k, i) => field(k, p, `j${i}`));
    const pitch = pick([["I have five years of relevant experience", ["experience"]], ["I love building reliable systems", ["reliable", "systems"]], ["I am excited about your product", ["excited"]]]);
    const form = `<h2>Apply: ${role}</h2><form>${fields.map((f) => f.html).join("")}
<label for="cover">${pick(["Why do you want to join?", "Cover note", "Tell us about yourself"])}</label><textarea id="cover" name="cover" rows="3"></textarea>
<button type="submit">${pick(["Submit application", "Apply now"])}</button></form>`;
    return {
      kind: "job",
      html: page({ title: `Careers — ${role}`, brand: pick(["Kite Systems", "Nimbus"]), formHtml: form, p, layout: 1 }),
      task: `Apply for the ${role} role using my vault details, say that ${pitch[0]}, and submit the application.`,
      check: (d) => keys.every((k) => d[k] === p[k]) && pitch[1].some((k) => (d.cover || "").toLowerCase().includes(k)),
    };
  },
  appointment(p) {
    const dept = pick(["Cardiology", "Dermatology", "General medicine", "Orthopaedics"]);
    const keys = shuffle(["NAME", "PHONE", ...(rnd() < 0.5 ? ["DOB"] : [])]);
    const fields = keys.map((k, i) => field(k, p, `p${i}`));
    const day = pick(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
    const form = `<h2>Book an appointment</h2><form>${fields.map((f) => f.html).join("")}
<label for="dept">Department</label><select id="dept" name="dept">${shuffle(["Cardiology", "Dermatology", "General medicine", "Orthopaedics"]).map((d) => `<option>${d}</option>`).join("")}</select>
<label for="day">Preferred day</label><select id="day" name="day">${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => `<option>${d}</option>`).join("")}</select>
<button type="submit">${pick(["Book appointment", "Confirm booking"])}</button></form>`;
    return {
      kind: "appointment",
      html: page({ title: "Appointments", brand: pick(["CareWell", "Banyan Health"]), formHtml: form, p, layout: pick([1, 2]) }),
      task: `Book a ${dept} appointment on ${day} using my vault details.`,
      check: (d) => keys.every((k) => d[k] === p[k]) && d.dept === dept && d.day === day,
    };
  },
  search(p) {
    const topics = shuffle(["Rotating API keys", "Two-factor setup", "Billing FAQ", "Exporting data", "Team permissions", "Webhooks"]);
    const target = topics[0];
    const query = target.split(" ")[pick([0, 1])].toLowerCase();
    const form = `<h2>Help center</h2><form id="sf" onsubmit="return false"><label for="q">Search articles</label><input id="q" name="q" autocomplete="off"><button id="go" type="button">Search</button></form>
<div id="res"></div><script>
const ARTS=${JSON.stringify(topics)};
function run(){const q=document.getElementById("q").value.toLowerCase();const hits=ARTS.filter(a=>a.toLowerCase().includes(q)).concat(ARTS.filter(a=>!a.toLowerCase().includes(q))).slice(0,4);
document.getElementById("res").innerHTML=hits.map(a=>'<p><a href="#" class="art" data-a="'+a+'">'+a+'</a></p>').join("");
document.querySelectorAll(".art").forEach(x=>x.onclick=()=>{document.body.dataset.submitted=JSON.stringify({opened:x.dataset.a});document.getElementById("res").innerHTML="<h3>"+x.dataset.a+"</h3><p>Article text…</p>";return false;});}
document.getElementById("go").onclick=run;document.getElementById("q").addEventListener("keydown",e=>{if(e.key==="Enter")run();});
</script>`;
    return {
      kind: "search",
      html: page({ title: "Help center", brand: pick(["Orbit Cloud", "Quill"]), formHtml: form, p, layout: 1 }),
      task: `Search the help center for "${query}" and open the article "${target}".`,
      check: (d) => d.opened === target,
    };
  },
};

const WIKI_TASKS = [
  ["Chandrayaan-3", /Chandrayaan-3/],
  ["Aryabhata", /Aryabhata/],
  ["Kaziranga National Park", /Kaziranga/],
  ["ISRO", /Indian_Space_Research_Organisation|ISRO/],
  ["Taj Mahal", /Taj_Mahal/],
  ["Srinivasa Ramanujan", /Ramanujan/],
  ["Bengaluru", /Bengaluru|Bangalore/],
  ["Konark Sun Temple", /Konark/],
  ["Sundarbans", /Sundarbans/],
  ["C. V. Raman", /Raman/],
];

// ------------------------------------------------------------ driver
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [ROOT], args: ["--window-size=1280,860"], defaultViewport: null });
  const log = [];
  try {
    const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"))).worker();
    const [blank] = await browser.pages();
    const tab = await browser.newPage();
    let currentHtml = "";
    await tab.setRequestInterception(true);
    tab.on("request", (r) => (r.url().startsWith("http://synthetic.stellar.test/") ? r.respond({ status: 200, contentType: "text/html", body: currentHtml }) : r.continue().catch(() => {})));
    await tab.goto("about:blank");
    if (blank) await blank.close();

    await sw.evaluate(
      (keys) => chrome.storage.local.set({ apiKey: keys, detector: "dom", pace: "fast", askRisky: true, maxSteps: 12, localBackup: "off", collectTraining: true, trainingSource: "datagen" }),
      KEYS
    );
    await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html?popout=1"), type: "popup", width: 560, height: 1000 }));
    const panel = await (await browser.waitForTarget((t) => t.url().includes("sidepanel.html"))).page();

    async function episode({ url, task, vault, check, kind }) {
      await sw.evaluate((v) => chrome.storage.local.set({ vault: v }), Object.entries(vault).map(([k, v]) => `${k}=${v}`).join("\n"));
      await tab.goto(url, { waitUntil: "load" }).catch(() => {});
      await tab.bringToFront();
      await panel.bringToFront();
      const before = (await panel.$$(".final")).length;
      await panel.$eval("#task", (t, v) => (t.value = v), task);
      await panel.click("#runBtn");
      const t0 = Date.now();
      while (Date.now() - t0 < 6 * 60_000) {
        if ((await panel.$$(".final")).length > before) break;
        const ok = await panel.$(".confirm-box .btn.ok");
        if (ok) await ok.click().catch(() => {});
        const ask = await panel.$(".ask-box textarea:not([disabled])");
        if (ask) await panel.click(".card .row .btn.danger").catch(() => {});
        await sleep(500);
      }
      if ((await panel.$$(".final")).length <= before) await panel.click("#stopBtn").catch(() => {});
      await sleep(800);
      const final = await panel.$eval(".run.sel .final", (e) => e.innerText.replace(/\s+/g, " ")).catch(() => "TIMEOUT");
      const steps = (await panel.$$(".run.sel .step")).length;
      let verified = false;
      try {
        verified = await check(tab);
      } catch {
        verified = false;
      }
      await panel.evaluate((v) => window.__stellarTraining.markLastEpisode({ verified: v }), verified);
      const entry = { kind, task, steps, ok: /^RESULT/i.test(final), verified, secs: Math.round((Date.now() - t0) / 1000), final: final.slice(0, 160) };
      log.push(entry);
      console.log(`[${log.length}] ${kind.padEnd(11)} ${entry.ok ? "done" : "STOP"} ${verified ? "✓verified" : "✗unverified"} ${steps} steps ${entry.secs}s — ${task.slice(0, 80)}`);
      await panel.click("#clearBtn").catch(() => {});
    }

    const kinds = Object.keys(TEMPLATES);
    for (let i = 0; i < EPISODES; i++) {
      const p = person();
      const kind = kinds[i % kinds.length];
      const t = TEMPLATES[kind](p);
      currentHtml = t.html;
      await episode({
        kind,
        url: `http://synthetic.stellar.test/${kind}/${i}`,
        task: t.task,
        vault: p,
        check: async (page) => t.check(JSON.parse((await page.evaluate(() => document.body.dataset.submitted)) || "{}")),
      });
    }
    for (const [topic, re] of WIKI_TASKS.slice(0, WIKI)) {
      await episode({
        kind: "wikipedia",
        url: "https://en.wikipedia.org/wiki/Main_Page",
        task: `Search Wikipedia for ${topic} and open its article, then tell me one key fact from the first paragraph.`,
        vault: {},
        check: async (page) => re.test(decodeURIComponent(page.url())),
      });
    }

    const { base64, stats } = await panel.evaluate(() => window.__stellarTraining.exportDataset());
    const zipPath = path.join(OUT, "stellar-dataset.zip");
    fs.writeFileSync(zipPath, Buffer.from(base64, "base64"));
    fs.writeFileSync(path.join(OUT, "episodes.json"), JSON.stringify(log, null, 2));
    console.log("STATS", JSON.stringify(stats));
    console.log("wrote", zipPath);
  } catch (e) {
    console.error("DATAGEN ERROR", e);
    fs.writeFileSync(path.join(OUT, "episodes.json"), JSON.stringify(log, null, 2));
  } finally {
    await browser.close();
  }
})();
