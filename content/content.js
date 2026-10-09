// Stellar content script.
//
// Injected on demand by the side panel (never auto-injected). It runs entirely
// on-device and is responsible for the local halves of the pipeline:
//   - DOM perception: enumerate visible interactive elements and give each a
//     semantic tag like [BUTTON_03] so the cloud model can refer to them.
//   - DOM PII detection: password fields, autofill-typed fields and regex hits
//     (emails, phones, cards, Aadhaar/PAN, API keys...) inside visible text.
//   - Execute: map a validated action back onto the real element and perform it.
//   - Overlay: a glowing "agent active" frame plus per-action highlights.
//
// The script is idempotent: re-injecting it into the same document is a no-op.

(() => {
  if (window.__stellar) return;

  const MAX_ELEMENTS = 150;
  const MAX_TEXT_CHARS = 400_000;

  // tag -> Element for the most recent scan. Actions may only target these.
  let elementMap = new Map();
  // Tags are stable for the lifetime of the document: an element keeps its tag
  // across scans (scrolling, re-renders of other nodes), new elements get new ones.
  const tagOf = new WeakMap();
  const tagCounters = {};

  // ---------------------------------------------------------------- helpers

  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function rectOf(r) {
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function intersectsViewport(r) {
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function isRendered(el) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) < 0.05) return false;
    return true;
  }

  // True when `el` is what the user would actually hit at some point inside it
  // (i.e. it is not covered by a modal, sticky header, etc.).
  function isTopMost(el, r) {
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + Math.min(6, r.width / 2), r.top + Math.min(6, r.height / 2)],
      [r.right - Math.min(6, r.width / 2), r.bottom - Math.min(6, r.height / 2)],
    ];
    for (const [px, py] of pts) {
      const x = Math.min(Math.max(px, 0), innerWidth - 1);
      const y = Math.min(Math.max(py, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === el || el.contains(hit)) return true;
      // Visually-hidden native checkbox/radio styled through its <label>.
      const label = hit.closest && hit.closest("label");
      if (label && label.control === el) return true;
    }
    return false;
  }

  // ------------------------------------------------------- element tagging

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=switch]",
    "[role=combobox]",
    "[role=textbox]",
    "[role=searchbox]",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    "[onclick]",
  ].join(",");

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "CHECKBOX";
      if (t === "file") return "UPLOAD";
      if (t === "radio") return "RADIO";
      if (["submit", "button", "reset", "image"].includes(t)) return "BUTTON";
      return "INPUT";
    }
    if (tag === "textarea" || el.isContentEditable) return "INPUT";
    if (tag === "select" || role === "combobox") return "SELECT";
    if (tag === "a" || role === "link") return "LINK";
    if (role === "checkbox" || role === "switch") return "CHECKBOX";
    if (role === "radio") return "RADIO";
    if (role === "tab") return "TAB";
    if (role === "menuitem" || role === "option") return "OPTION";
    if (role === "textbox" || role === "searchbox") return "INPUT";
    return "BUTTON";
  }

  function textOfIds(ids) {
    return collapse(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
    );
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(collapse(aria));
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = textOfIds(by);
      if (t) return clip(t);
    }
    if (el.labels && el.labels.length) {
      const t = collapse([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return clip(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const t = el.type;
      if (["submit", "button", "reset"].includes(t) && el.value) return clip(collapse(el.value));
      return clip(collapse(el.placeholder || el.title || el.name || el.id || ""));
    }
    if (tag === "select") {
      const sel = el.options[el.selectedIndex];
      return clip(collapse((el.title || el.name || "") + (sel ? ` (selected: ${sel.text})` : "")));
    }
    const text = collapse(el.innerText || el.textContent || "");
    if (text) return clip(text);
    const img = el.querySelector("img[alt], svg[aria-label], [title]");
    if (img) return clip(collapse(img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title")));
    if (el.title) return clip(collapse(el.title));
    // Icon-only buttons often carry a test id such as "console-run-button".
    const hint = el.getAttribute("data-e2e-locator") || el.getAttribute("data-testid") || el.getAttribute("data-cy") || el.id || "";
    return clip(collapse(hint.replace(/[-_]+/g, " ")));
  }

  function isSensitiveField(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    const type = (el.type || "").toLowerCase();
    const ac = (el.autocomplete || "").toLowerCase();
    const hint = `${el.name} ${el.id} ${ac}`.toLowerCase();
    if (type === "password") return true;
    if (/cc-|one-time-code|current-password|new-password/.test(ac)) return true;
    return /pass(word)?|pwd|otp|cvv|cvc|card.?num|iban|ssn|aadhaar|aadhar|secret|token|api.?key|\bpin\b/.test(hint);
  }

  function uploadName(el) {
    const own = nameOf(el);
    const standIn = uploadStandIn.get(el);
    const near = standIn && standIn !== el ? collapse(standIn.innerText || standIn.textContent || "") : "";
    const label = [own && !/^(file|upload|input)$/i.test(own) ? own : "", near].filter(Boolean).join(" — ") || "File upload";
    return clip(`${label}${el.accept ? ` (accepts ${el.accept})` : ""}`);
  }

  // Code editors keep their real input in a hidden 1-px textarea (Monaco) or a
  // contenteditable deep inside (CodeMirror 6), so they are tagged as one
  // INPUT on the visible editor box instead.
  const CODE_EDITORS = ".monaco-editor, .CodeMirror, .cm-editor, .ace_editor";
  function editorKind(el) {
    if (el.classList.contains("monaco-editor")) return "Monaco";
    if (el.classList.contains("CodeMirror") || el.classList.contains("cm-editor")) return "CodeMirror";
    if (el.classList.contains("ace_editor")) return "Ace";
    return null;
  }
  function editorName(el) {
    const first = el.querySelector(".view-line, .CodeMirror-line, .cm-line, .ace_line");
    const preview = collapse(first?.textContent || "").slice(0, 40);
    return `Code editor (${editorKind(el)})${preview ? ` — starts "${preview}"` : ""}`;
  }

  const uploadStandIn = new WeakMap();
  /** The visible element standing in for a (possibly hidden) file input. */
  function uploadProxy(input) {
    const visible = (n) => {
      if (!n) return false;
      const r = n.getBoundingClientRect();
      return r.width >= 4 && r.height >= 4 && isRendered(n);
    };
    if (visible(input)) return input;
    const options = [...(input.labels || []), input.closest("label"), input.id && document.querySelector(`[for="${CSS.escape(input.id)}"]`)];
    // A nearby button/drop area in the same wrapper (up to three levels).
    for (let p = input.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      options.push(p.querySelector("button, [role=button], label, [class*=upload i], [class*=drop i]"));
      options.push(p);
    }
    return options.find((n) => n && n !== document.body && visible(n) && n.getBoundingClientRect().height < 400) || null;
  }

  function scanElements() {
    const candidates = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(CODE_EDITORS)) {
      if (el.parentElement?.closest(CODE_EDITORS)) continue; // outermost editor box only
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20 || !intersectsViewport(r) || !isRendered(el)) continue;
      seen.add(el);
      candidates.push({ el, r });
    }
    // File inputs are usually invisible behind a styled "Upload" label or
    // button; tag the input itself, placed where its visible stand-in is.
    for (const el of document.querySelectorAll("input[type=file]")) {
      seen.add(el);
      const proxy = uploadProxy(el);
      if (!proxy) continue;
      const r = proxy.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !intersectsViewport(r)) continue;
      uploadStandIn.set(el, proxy);
      candidates.push({ el, r });
    }
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest(CODE_EDITORS)) continue; // the editor box stands for its insides
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !intersectsViewport(r)) continue;
      if (!isRendered(el) || !isTopMost(el, r)) continue;
      candidates.push({ el, r });
    }

    // Drop wrappers/children that duplicate an already-collected element
    // (e.g. <a><button>Go</button></a>), keeping the outermost one.
    const kept = [];
    for (const c of candidates) {
      const dup = kept.find((k) => {
        if (!(k.el.contains(c.el) || c.el.contains(k.el))) return false;
        const ix = Math.max(0, Math.min(k.r.right, c.r.right) - Math.max(k.r.left, c.r.left));
        const iy = Math.max(0, Math.min(k.r.bottom, c.r.bottom) - Math.max(k.r.top, c.r.top));
        const inter = ix * iy;
        const union = k.r.width * k.r.height + c.r.width * c.r.height - inter;
        return union > 0 && inter / union > 0.8;
      });
      if (!dup) kept.push(c);
    }

    kept.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    const limited = kept.slice(0, MAX_ELEMENTS);

    elementMap = new Map();
    return limited.map(({ el, r }) => {
      const editor = editorKind(el);
      const kind = editor ? "INPUT" : kindOf(el);
      let tag = tagOf.get(el);
      if (!tag || !tag.startsWith(`${kind}_`)) {
        tagCounters[kind] = (tagCounters[kind] || 0) + 1;
        tag = `${kind}_${String(tagCounters[kind]).padStart(2, "0")}`;
        tagOf.set(el, tag);
      }
      elementMap.set(tag, el);
      const info = {
        tag,
        kind,
        name: editor ? editorName(el) : kind === "UPLOAD" ? uploadName(el) : nameOf(el),
        rect: rectOf(r),
        disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
        sensitive: isSensitiveField(el),
      };
      if (el instanceof HTMLInputElement) info.inputType = (el.type || "text").toLowerCase();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) info.filled = el.value.length > 0;
      if (autofillHidden(el)) {
        info.filled = true;
        info.autofilled = true;
      }
      if (kind === "UPLOAD") {
        info.accept = el.accept || "";
        info.filled = el.files?.length > 0;
        if (info.filled) info.fileName = el.files[0].name;
      }
      if (editor) {
        info.editor = editor;
        info.filled = collapse(el.innerText || "").length > 0;
        el.dataset.stellarTag = tag; // lets the page-world editor API call find this box
      }
      if (el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(info.name)) info.required = true;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) info.checked = el.checked;
      const expanded = el.getAttribute("aria-expanded");
      if (expanded) info.expanded = expanded === "true";
      const form = el.form || el.closest("form");
      if (form) info.form = [...document.forms].indexOf(form);
      if (el instanceof HTMLSelectElement) {
        info.options = [...el.options].slice(0, 40).map((o) => o.text.trim()).filter(Boolean);
        info.selected = el.options[el.selectedIndex]?.text.trim() || "";
      }
      return info;
    });
  }

  // -------------------------------------------------------- DOM PII detection

  function luhn(digits) {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  // Ordered by priority: earlier patterns win when matches overlap.
  const PII_PATTERNS = [
    {
      category: "API_KEY",
      re: /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    },
    // UPI IDs (name@okaxis, …) and IFSC codes.
    { category: "BANK_ACCOUNT", re: /\b[A-Za-z0-9._-]{2,}@(?:ok(?:axis|hdfcbank|icici|sbi)|upi|ybl|paytm|axl|ibl|apl)\b/gi },
    { category: "BANK_ACCOUNT", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
    { category: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    {
      category: "CREDIT_CARD",
      re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
      accept: (m) => {
        const d = m.replace(/\D/g, "");
        return d.length >= 13 && d.length <= 19 && luhn(d);
      },
    },
    { category: "GOV_ID", re: /(?<!\d)[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?!\d)/g }, // Aadhaar
    { category: "GOV_ID", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g }, // PAN
    { category: "PHONE", re: /(?<![\w+])(?:\+91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g },
    { category: "PHONE", re: /(?<!\w)\+\d{1,3}[ ().-]*\d{2,4}[ ().-]*\d{3,4}[ .-]*\d{3,4}(?!\d)/g },
    { category: "PHONE", re: /\(\d{3}\) ?\d{3}-\d{4}(?!\d)/g },
  ];
  // A bare digit run is only an account number when its label says so.
  const ACCOUNT_CONTEXT = /\b(?:bank|account|acct|a\/c)\b/i;
  const ACCOUNT_NUMBER = /(?<![\d+])\d(?:[ -]?\d){8,17}(?!\d)/g;

  // `known` are the user's vault values ({tag, value}); they are redacted under
  // their own vault tag wherever they appear (e.g. after the agent typed them).
  function findPiiInString(text, known = [], context = "", names = []) {
    const hits = [];
    for (const k of known) {
      let i = text.indexOf(k.value);
      while (i >= 0) {
        const end = i + k.value.length;
        if (!hits.some((h) => i < h.end && end > h.start)) hits.push({ category: "VAULT", vaultTag: k.tag, start: i, end, value: k.value });
        i = text.indexOf(k.value, end);
      }
    }
    for (const n of names) {
      let i = text.indexOf(n);
      while (i >= 0) {
        const end = i + n.length;
        const whole = !/[\p{L}\p{N}]/u.test(text[i - 1] || "") && !/[\p{L}\p{N}]/u.test(text[end] || "");
        if (whole && !hits.some((h) => i < h.end && end > h.start)) hits.push({ category: "PERSON_NAME", start: i, end, value: n });
        i = text.indexOf(n, end);
      }
    }
    for (const p of PII_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (p.accept && !p.accept(m[0])) continue;
        if (hits.some((h) => start < h.end && end > h.start)) continue;
        hits.push({ category: p.category, start, end, value: m[0] });
      }
    }
    if (ACCOUNT_CONTEXT.test(context) || ACCOUNT_CONTEXT.test(text)) {
      ACCOUNT_NUMBER.lastIndex = 0;
      let m;
      while ((m = ACCOUNT_NUMBER.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (!hits.some((h) => start < h.end && end > h.start)) hits.push({ category: "BANK_ACCOUNT", start, end, value: m[0] });
      }
    }
    return hits;
  }

  function fieldCategory(el) {
    const type = (el.type || "").toLowerCase();
    const ac = (el.autocomplete || "").toLowerCase();
    const hint = `${el.name} ${el.id} ${ac}`.toLowerCase();
    if (type === "password" || /password/.test(ac)) return "PASSWORD";
    if (/one-time-code/.test(ac) || /\botp\b/.test(hint)) return "OTP";
    if (/cc-csc/.test(ac) || /cvv|cvc/.test(hint)) return "CVV";
    if (/cc-/.test(ac) || /card.?num/.test(hint)) return "CREDIT_CARD";
    if (type === "email" || /email/.test(ac)) return "EMAIL";
    if (type === "tel" || /\btel\b/.test(ac)) return "PHONE";
    if (/street-address|address-line|postal-code/.test(ac)) return "ADDRESS";
    if (/\b(name|given-name|family-name)\b/.test(ac)) return "PERSON_NAME";
    if (/bday/.test(ac)) return "DOB";
    if (/pass|pwd|secret|token|api.?key|\bpin\b/.test(hint)) return "PASSWORD";
    if (/aadhaar|aadhar|\bpan\b|ssn/.test(hint)) return "GOV_ID";
    if (/iban|ifsc|\bupi\b|acc(?:oun)?t.?(?:no|num)/.test(hint)) return "BANK_ACCOUNT";
    return null;
  }

  function scanPii(known = [], names = []) {
    const found = [];
    known = known.filter((k) => k && typeof k.value === "string" && k.value.length >= 3);
    names = names.filter((n) => !known.some((k) => k.value === n));

    // 1. Form fields: anything typed into a sensitive field is redacted whole.
    for (const el of document.querySelectorAll("input:not([type=hidden]), textarea")) {
      if (!el.value) {
        // Browser-autofilled values are drawn on screen but read as "" until the
        // user interacts with the page — redact the whole field anyway.
        if (!autofillHidden(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || !intersectsViewport(r) || !isRendered(el)) continue;
        found.push({ category: fieldCategory(el) || "OTHER_PII", rect: rectOf(r), value: "", source: "dom", detail: "browser-autofilled field" });
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || !intersectsViewport(r) || !isRendered(el)) continue;
      const kv = known.find((k) => el.value.includes(k.value));
      if (kv) {
        found.push({ category: "VAULT", vaultTag: kv.tag, rect: rectOf(r), value: kv.value, source: "dom", detail: "vault value in field" });
        continue;
      }
      const cat = fieldCategory(el);
      if (cat) {
        found.push({ category: cat, rect: rectOf(r), value: el.value, source: "dom", detail: `${el.type || "text"} field` });
        continue;
      }
      const hits = findPiiInString(el.value);
      if (hits.length) {
        found.push({ category: hits[0].category, rect: rectOf(r), value: el.value, source: "dom", detail: "field value" });
      }
    }

    // 2. Visible text nodes.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.nodeValue.trim().length < 3) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let budget = MAX_TEXT_CHARS;
    let node;
    while ((node = walker.nextNode()) && budget > 0) {
      const text = node.nodeValue;
      budget -= text.length;
      // The label next to a value (e.g. <dt>Bank account</dt><dd>…</dd>) gives context.
      const p = node.parentElement;
      const label = (p.previousElementSibling?.textContent || "") + " " + (p.getAttribute("aria-label") || "");
      const hits = findPiiInString(text, known, label.slice(0, 80), names);
      for (const h of hits) {
        const range = document.createRange();
        range.setStart(node, h.start);
        range.setEnd(node, h.end);
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.height < 2 || !intersectsViewport(r)) continue;
          found.push({ category: h.category, vaultTag: h.vaultTag, rect: rectOf(r), value: h.value, source: "dom", detail: h.vaultTag ? "vault value in text" : h.category === "PERSON_NAME" ? "person's name" : "page text" });
        }
      }
    }
    return found;
  }

  // ------------------------------------------------- people's names
  // Names are found where sites mark them — links to profiles, "X's profile
  // picture" labels, author/username fields, "Name <email>" — and then hidden
  // wherever they appear. Job titles, companies and places stay visible.
  const PROFILE_HREF =
    /linkedin\.com\/in\/|youtube\.com\/(?:@|channel\/|c\/|user\/)|\/@[\w.-]+\/?(?:$|\?)|(?:twitter|x)\.com\/(?!home|explore|search|i\/|settings|notifications|messages)[\w]{2,}\/?(?:$|\?)|facebook\.com\/(?!pages|groups|watch|marketplace|events|gaming)[\w.]{3,}\/?(?:$|\?)|instagram\.com\/(?!explore|reels|p\/)[\w.]{2,}\/?(?:$|\?)|github\.com\/(?!features|topics|orgs|settings|marketplace|explore|pulls|issues|notifications|login|signup)[\w-]{2,}\/?(?:$|\?)|\/(?:profile|people|users?|members?|author|authors)\/[\w.-]+/i;
  const NAME_LABELS = [
    /^(.{2,60}?)['’]s (?:profile (?:picture|photo|image)|avatar|photo|picture|profile|channel|account)\b/i,
    /\b(?:profile (?:picture|photo|image) (?:of|for)|photo of|picture of|avatar (?:of|for))\s+(.{2,60}?)\.?$/i,
    /^(?:view|visit|go to|open)\s+(.{2,60}?)['’]s?\s+(?:profile|channel|page)\b/i,
    /^Google Account:?\s*(.{2,60}?)\s*\(/i,
  ];
  const AUTHOR_SELECTOR =
    "[rel=author], [itemprop=author], [class*=author i]:not([class*=authorization i]), [class*=username i], [class*=user-name i], [class*=display-name i], [class*=displayname i], [class*=profile-name i], [class*=actor-name i], [class*=actor__name i], [class*=commenter i], [class*=sender-name i], #author-text, ytd-channel-name, [data-testid=User-Name], [data-hovercard-id]";
  const UI_WORDS = /^(home|profile|my network|network|jobs|messaging|messages|notifications|me|you|follow|following|followers|connect|message|more|see all|view profile|show more|show less|subscribe|subscribed|share|like|comment|repost|send|search|menu|settings|sign in|sign out|log in|log out|join now|premium|post|posts|about|channel|videos|shorts|live|playlists|community|reply|replies|edit|delete|report|open|close|anonymous|unknown|admin|guest|user|author|team|support|the|a|an)$/i;

  function nameLike(raw) {
    const t = collapse(String(raw || "")).replace(/\s*[·•|].*$/, "").replace(/\s*\(.*\)$/, "").replace(/[✓✔•·]+$/, "").trim();
    if (t.length < 3 || t.length > 50 || UI_WORDS.test(t)) return null;
    if (/^@[\w.-]{2,30}$/.test(t)) return t; // a handle
    if (/@|https?:|www\.|\d{2,}|[!?:;,"]/.test(t)) return null;
    const words = t.split(" ");
    if (words.length > 5) return null;
    if (!/^[\p{L}][\p{L}\p{M}.'’\- ]*$/u.test(t)) return null;
    // People's names are capitalised (or a single-word handle-like name).
    if (!words.every((w) => /^[\p{Lu}\p{Lo}]/u.test(w) || /^(de|da|van|von|bin|al|le|la|di|del|dos|du|el)$/i.test(w))) return null;
    return t;
  }

  function findNames() {
    const names = new Set();
    const add = (n) => {
      const t = nameLike(n);
      if (t) names.add(t);
    };
    const onScreen = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && intersectsViewport(r);
    };
    // Labels: alt / aria-label / title such as "Priya Raman's profile picture".
    for (const el of document.querySelectorAll("[aria-label], img[alt], [title]")) {
      if (names.size > 200) break;
      if (!onScreen(el)) continue;
      for (const v of [el.getAttribute("aria-label"), el.getAttribute("alt"), el.getAttribute("title")]) {
        if (!v || v.length > 200) continue;
        for (const part of v.split(/,\s*/)) for (const re of NAME_LABELS) {
          const m = part.trim().match(re);
          if (m) add(m[1]);
        }
      }
    }
    // Links to people's profiles: their text is the person's name.
    for (const a of document.querySelectorAll("a[href]")) {
      if (names.size > 200) break;
      if (!PROFILE_HREF.test(a.href) || !onScreen(a)) continue;
      const lines = (a.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines[0]) add(lines[0]);
      const handle = a.href.match(/\/(@[\w.-]{2,30})/);
      if (handle) add(handle[1]);
    }
    // Author / username / display-name fields.
    for (const el of document.querySelectorAll(AUTHOR_SELECTOR)) {
      if (names.size > 200) break;
      if (!onScreen(el)) continue;
      const first = (el.innerText || el.textContent || "").split("\n").map((l) => l.trim()).find(Boolean);
      if (first) add(first);
    }
    // "Name <email>" (mail clients, contact lists).
    const body = (document.body?.innerText || "").slice(0, 60000);
    for (const m of body.matchAll(/([\p{Lu}][\p{L}.'’-]+(?: [\p{Lu}][\p{L}.'’-]+){0,3})\s*<[^<>\s@]+@[^<>\s]+>/gu)) add(m[1]);
    // First names on their own ("Message Priya") once the full name is known.
    for (const n of [...names]) {
      const first = n.split(" ")[0];
      if (n.includes(" ") && first.length >= 3 && !UI_WORDS.test(first) && /^\p{Lu}/u.test(first)) names.add(first);
    }
    return [...names].sort((a, b) => b.length - a.length);
  }

  // Visible images, videos and canvases: where the on-device face detector zooms in.
  function scanImages() {
    const out = [];
    for (const el of document.querySelectorAll("img, video, canvas, picture, [role=img], [style*='background-image']")) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24 || !intersectsViewport(r) || !isRendered(el)) continue;
      out.push(rectOf(r));
      if (out.length >= 60) break;
    }
    return out;
  }

  // ------------------------------------------------------------- overlay UI

  let overlayHost = null;
  let overlayRoot = null;

  function ensureOverlay() {
    if (overlayHost && overlayHost.isConnected) return overlayRoot;
    overlayHost = document.createElement("div");
    overlayHost.id = "__stellar_overlay";
    overlayHost.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    overlayRoot = overlayHost.attachShadow({ mode: "closed" });
    overlayRoot.innerHTML = `
      <style>
        .frame{position:fixed;inset:0;border:3px solid transparent;
          border-image:linear-gradient(135deg,#00f0ff,#7c3aed,#d946ef) 1;
          box-shadow:inset 0 0 24px rgba(56,189,248,.35);animation:pulse 2.4s ease-in-out infinite}
        @keyframes pulse{50%{box-shadow:inset 0 0 40px rgba(124,58,237,.45)}}
        .pill{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);
          font:600 12px/1 system-ui,sans-serif;color:#f5f6f8;background:rgba(6,6,8,.88);
          border:1px solid rgba(124,58,237,.6);padding:8px 12px;border-radius:999px;
          display:flex;gap:8px;align-items:center;letter-spacing:.2px}
        .dot{width:8px;height:8px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8}
        .hl{position:fixed;border:2px solid #38bdf8;border-radius:6px;background:rgba(56,189,248,.12);
          box-shadow:0 0 0 4px rgba(56,189,248,.25),0 0 24px rgba(124,58,237,.6);transition:opacity .4s}
        .hl span{position:absolute;top:-24px;left:-2px;font:600 11px/1 ui-monospace,monospace;
          background:#7c3aed;color:#fff;padding:5px 7px;border-radius:5px;white-space:nowrap}
      </style>
      <div class="frame"></div>
      <div class="pill"><span class="dot"></span><span class="msg">Stellar agent active</span></div>`;
    document.documentElement.appendChild(overlayHost);
    return overlayRoot;
  }

  function setOverlay({ visible, message }) {
    if (visible === false) {
      if (overlayHost) overlayHost.style.display = "none";
      return;
    }
    const root = ensureOverlay();
    overlayHost.style.display = "";
    if (message) root.querySelector(".msg").textContent = message;
  }

  function removeOverlay() {
    overlayHost?.remove();
    overlayHost = null;
    overlayRoot = null;
  }

  function flash(el, label) {
    if (!overlayHost || overlayHost.style.display === "none") return;
    const r = el.getBoundingClientRect();
    const hl = document.createElement("div");
    hl.className = "hl";
    hl.style.cssText = `left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 2}px;height:${r.height + 2}px`;
    const chip = document.createElement("span");
    chip.textContent = label;
    hl.appendChild(chip);
    overlayRoot.appendChild(hl);
    setTimeout(() => (hl.style.opacity = "0"), 900);
    setTimeout(() => hl.remove(), 1300);
  }

  // ---------------------------------------------------------------- execute

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setNativeValue(el, value) {
    // Calling the prototype setter from the isolated world bypasses framework
    // value trackers (React etc.), so the input event below registers a change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pointerSequence(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
    };
    el.dispatchEvent(new PointerEvent("pointerover", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.click();
  }

  const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32 };

  function pressKey(key, target) {
    const t = target || document.activeElement || document.body;
    const k = key === "Space" ? " " : key;
    const init = { key: k, code: key, keyCode: KEY_CODES[key] || 0, which: KEY_CODES[key] || 0, bubbles: true, cancelable: true, composed: true };
    const down = t.dispatchEvent(new KeyboardEvent("keydown", init));
    t.dispatchEvent(new KeyboardEvent("keypress", init));
    t.dispatchEvent(new KeyboardEvent("keyup", init));
    // Synthetic Enter does not trigger implicit form submission; do it here
    // unless the page handled the keydown itself.
    if (key === "Enter" && down && t.form && t instanceof HTMLInputElement) {
      if (typeof t.form.requestSubmit === "function") t.form.requestSubmit();
      else t.form.submit();
    }
  }

  // ------------------------------------------------- human verification
  // Stellar never solves CAPTCHAs or bot checks. It only detects them so the
  // agent can pause and hand control to the user, then resume once the
  // widget's response token is filled (or the interstitial page is gone).

  // A check is only reported when its challenge iframe is actually on screen at
  // widget size. Invisible reCAPTCHA (v3 / size=invisible), its corner badge and
  // pre-created hidden challenge frames are ignored — they are not something the
  // user has to solve.
  const CHALLENGES = [
    { kind: "Cloudflare Turnstile", frame: /challenges\.cloudflare\.com/i, token: '[name="cf-turnstile-response"]' },
    { kind: "reCAPTCHA", frame: /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i, invisible: /[?&]size=invisible/i, token: '[name="g-recaptcha-response"]' },
    { kind: "hCaptcha", frame: /hcaptcha\.com/i, token: '[name="h-captcha-response"]' },
    { kind: "Arkose / FunCaptcha", frame: /arkoselabs|funcaptcha/i, token: '[name="fc-token"], #FunCaptcha-Token' },
  ];
  const CHALLENGE_CONTAINERS = ".cf-turnstile, .g-recaptcha, .h-captcha, #challenge-form, #challenge-stage";

  function challengeElSelector() {
    return CHALLENGE_CONTAINERS;
  }

  // Widgets such as Cloudflare Turnstile render their iframe inside a *closed*
  // shadow root, invisible to querySelector. Extensions may open it with
  // chrome.dom.openOrClosedShadowRoot, so search through every shadow root.
  function deepQueryAll(selector) {
    const out = [];
    const visit = (root) => {
      out.push(...root.querySelectorAll(selector));
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        let sr = n.shadowRoot;
        if (!sr) {
          try {
            sr = chrome.dom?.openOrClosedShadowRoot?.(n);
          } catch {
            sr = null;
          }
        }
        if (sr) visit(sr);
      }
    };
    visit(document);
    return out;
  }

  /** Is this element really visible: on screen, widget-sized, and no ancestor hides it? */
  function shownOnScreen(el, minW = 120, minH = 40) {
    const r = el.getBoundingClientRect();
    if (r.width < minW || r.height < minH || !intersectsViewport(r)) return false;
    for (let cur = el, i = 0; cur && i < 40; i++) {
      if (cur instanceof Element) {
        const st = getComputedStyle(cur);
        if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) < 0.05) return false;
      }
      cur = cur.parentElement || cur.getRootNode?.()?.host || null;
    }
    return true;
  }

  function detectChallenge() {
    // Cloudflare / bot-manager interstitial pages.
    if (/^just a moment|^attention required|^one more step|^security check/i.test(document.title.trim()) || document.querySelector("#challenge-form, #challenge-stage, #cf-challenge-running")) {
      return { pending: true, kind: "Cloudflare browser check" };
    }
    const frames = deepQueryAll("iframe");
    for (const c of CHALLENGES) {
      const shown = frames.filter((f) => {
        const src = f.src || f.getAttribute("src") || "";
        if (!c.frame.test(src) || (c.invisible && c.invisible.test(src))) return false;
        if (f.closest(".grecaptcha-badge")) return false;
        return shownOnScreen(f);
      });
      if (!shown.length) continue;
      // Widgets fill their response field once the user passes the check.
      const solved = [...document.querySelectorAll(c.token)].some((t) => (t.value || "").length > 10);
      if (solved) continue;
      return { pending: true, kind: c.kind, rect: rectOf(shown[0].getBoundingClientRect()) };
    }
    return { pending: false };
  }

  // ------------------------------------------------- browser autofill
  // Chrome fills saved logins on page load but hides the values from every
  // script (the page's own and extensions') until a real user gesture on the
  // page. Synthetic clicks don't count, so waiting or retrying never helps:
  // the user has to click the page once.
  function autofillHidden(el) {
    if (!(el instanceof HTMLInputElement) || el.value) return false;
    for (const sel of [":autofill", ":-webkit-autofill"]) {
      try {
        if (el.matches(sel)) return true;
      } catch {
        /* selector unsupported */
      }
    }
    return false;
  }

  function detectAutofill() {
    const fields = [...document.querySelectorAll("input:not([type=hidden])")].filter((el) => {
      if (!autofillHidden(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && intersectsViewport(r) && isRendered(el);
    });
    return { pending: fields.length > 0, fields: fields.map((el) => nameOf(el) || el.type).slice(0, 5) };
  }

  // A point inside the login form where a real click does nothing: not a
  // field, button, link, label, CAPTCHA or anything clickable, and never
  // outside the form (a click there could close a sign-in dialog).
  const NOT_QUIET =
    "a, button, input, select, textarea, label, summary, option, iframe, video, [role=button], [role=link], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [onclick], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
  function quietPoint() {
    const field = [...document.querySelectorAll("input:not([type=hidden])")].find((el) => autofillHidden(el) && isRendered(el));
    if (!field) return null;
    const challengeRects = deepQueryAll(`iframe, ${CHALLENGE_CONTAINERS}`)
      .filter((f) => f.matches(CHALLENGE_CONTAINERS) || CHALLENGES.some((c) => c.frame.test(f.src || "")))
      .map((f) => f.getBoundingClientRect());
    const isQuiet = (x, y, scope) => {
      const el = document.elementFromPoint(x, y);
      if (!el || !scope.contains(el) || el.closest(NOT_QUIET) || el.closest(CHALLENGE_CONTAINERS)) return false;
      if (getComputedStyle(el).cursor === "pointer") return false;
      if (challengeRects.some((r) => x > r.left - 12 && x < r.right + 12 && y > r.top - 12 && y < r.bottom + 12)) return false;
      return true;
    };
    // The form first, then up to three wrappers around it (the card or dialog body).
    let scope = field.form || field.closest("form") || field.parentElement;
    for (let level = 0; scope && scope !== document.body && level < 4; level++, scope = scope.parentElement) {
      const r = scope.getBoundingClientRect();
      const left = Math.max(r.left, 0) + 4;
      const right = Math.min(r.right, innerWidth) - 4;
      const top = Math.max(r.top, 0) + 4;
      const bottom = Math.min(r.bottom, innerHeight) - 4;
      for (let y = top; y < bottom; y += 10) {
        for (let x = left; x < right; x += 10) {
          if (isQuiet(x, y, scope)) return { x: Math.round(x), y: Math.round(y), on: scope.tagName.toLowerCase() };
        }
      }
    }
    return null;
  }

  function inspect(tag) {
    const el = elementMap.get(tag);
    if (!el) return { exists: false };
    const r = el.getBoundingClientRect();
    return {
      exists: true,
      connected: el.isConnected,
      // A hidden file input counts as visible through its stand-in label/button.
      visible: el.isConnected && ((r.width > 0 && r.height > 0 && isRendered(el)) || !!uploadStandIn.get(el)),
      disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
      kind: kindOf(el),
      name: nameOf(el),
      sensitive: isSensitiveField(el),
      editable:
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !["checkbox", "radio", "submit", "button", "reset", "image", "file"].includes(el.type)) ||
        el.isContentEditable ||
        !!editorKind(el),
      editor: editorKind(el),
      isUpload: el instanceof HTMLInputElement && el.type === "file",
      isSelect: el instanceof HTMLSelectElement,
      inChallenge: !!el.closest(challengeElSelector()),
    };
  }

  // ------------------------------------------------ real-input helpers
  // The side panel sends real mouse/keyboard input through chrome.debugger;
  // these find where to click and check the result afterwards.

  function inChallengeArea(x, y) {
    const frames = deepQueryAll("iframe").filter((f) => CHALLENGES.some((c) => c.frame.test(f.src || f.getAttribute("src") || "")));
    const boxes = [...frames, ...document.querySelectorAll(CHALLENGE_CONTAINERS)].map((n) => n.getBoundingClientRect());
    return boxes.some((r) => x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8);
  }

  /** A visible, unobstructed point on the target — never on a CAPTCHA / bot check. */
  async function pointFor(tag) {
    const el = elementMap.get(tag);
    if (!el || !el.isConnected) return { ok: false, reason: `element ${tag} is no longer on the page` };
    if (el.closest(challengeElSelector())) return { ok: false, reason: "target is part of a CAPTCHA / bot check", challenge: true };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await sleep(80);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, reason: `${tag} has no size on screen` };
    const hits = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit) || (el.labels && [...el.labels].some((l) => l.contains(hit))));
    };
    const candidates = [
      [0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.3], [0.5, 0.7], [0.15, 0.5], [0.85, 0.5],
    ].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]);
    for (const [x, y] of candidates) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      if (inChallengeArea(x, y)) return { ok: false, reason: "that point is on a CAPTCHA / bot check", challenge: true };
      if (hits(x, y)) {
        showCursor(x, y);
        flash(el, `real input [${tag}]`);
        return { ok: true, x: Math.round(x), y: Math.round(y) };
      }
    }
    return { ok: false, reason: `${tag} is covered by another element` };
  }

  /** Attach a file from the private vault to a file input (or drop it on a drop zone). */
  function uploadTo(tag, f) {
    const el = elementMap.get(tag);
    if (!el || !el.isConnected) return { ok: false, detail: `element ${tag} is no longer on the page` };
    if (el.closest(challengeElSelector())) return { ok: false, detail: "that is part of a CAPTCHA / bot check" };
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], f.name, { type: f.type || "application/octet-stream", lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = el instanceof HTMLInputElement && el.type === "file" ? el : el.querySelector?.("input[type=file]");
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const ok = input.files.length > 0 && input.files[0].name === f.name;
      const accept = (input.accept || "").toLowerCase();
      const ext = "." + f.name.split(".").pop().toLowerCase();
      const mismatch = accept && !accept.split(",").some((a) => (a = a.trim()) && (a === ext || a === f.type || (a.endsWith("/*") && f.type.startsWith(a.slice(0, -1)))));
      return { ok, detail: ok ? `attached ${f.name}${mismatch ? ` (note: the field accepts ${input.accept})` : ""}` : "the page refused the file" };
    }
    const target = uploadStandIn.get(el) || el;
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, detail: `dropped ${f.name} onto ${tag}` };
  }

  /** What the target holds now — to confirm real typing/selection worked. */
  function readback(tag) {
    const el = elementMap.get(tag);
    if (!el) return { exists: false };
    if (el instanceof HTMLSelectElement) return { exists: true, value: el.options[el.selectedIndex]?.text || "" };
    if (editorKind(el)) {
      const lines = el.querySelectorAll(".view-line, .CodeMirror-line, .cm-line, .ace_line");
      return { exists: true, value: [...lines].map((l) => l.textContent).join("\n"), editor: true };
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return { exists: true, value: el.value, focused: document.activeElement === el };
    return { exists: true, value: (el.innerText || el.textContent || "").slice(0, 2000), focused: el.contains(document.activeElement) };
  }

  /** A visible cursor that glides to where real input lands (demo aid). */
  function showCursor(x, y) {
    if (!overlayHost || overlayHost.style.display === "none") return;
    let c = overlayRoot.querySelector(".cursor");
    if (!c) {
      c = document.createElement("div");
      c.className = "cursor";
      c.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(139,92,246,.35);border:2px solid #8b5cf6;box-shadow:0 0 0 6px rgba(139,92,246,.15);transition:transform .35s ease;pointer-events:none;z-index:2";
      overlayRoot.appendChild(c);
    }
    c.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  async function execute(action) {
    const { type } = action;
    if (type === "scroll") {
      const dir = action.direction === "up" ? -1 : 1;
      const el = action.target ? elementMap.get(action.target) : null;
      const target = el && el.scrollHeight > el.clientHeight ? el : null;
      const amount = Math.round((target ? target.clientHeight : innerHeight) * 0.75) * dir;
      if (target) target.scrollBy({ top: amount, behavior: "instant" });
      else window.scrollBy({ top: amount, behavior: "instant" });
      return { ok: true, detail: `scrolled ${action.direction || "down"} ${Math.abs(amount)}px` };
    }
    if (type === "press_key") {
      const el = action.target ? elementMap.get(action.target) : null;
      if (el) el.focus();
      pressKey(action.key || "Enter", el);
      return { ok: true, detail: `pressed ${action.key || "Enter"}` };
    }

    const el = elementMap.get(action.target);
    if (!el || !el.isConnected) return { ok: false, detail: `element ${action.target} is no longer on the page` };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await sleep(60);
    flash(el, `${type} [${action.target}]`);

    if (type === "click") {
      pointerSequence(el);
      return { ok: true, detail: `clicked ${action.target}` };
    }

    if (type === "type") {
      const text = action.text ?? "";
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const next = action.clear === false ? el.value + text : text;
        setNativeValue(el, next);
      } else if (el.isContentEditable) {
        if (action.clear !== false) document.execCommand("selectAll", false);
        document.execCommand("insertText", false, text);
      } else {
        return { ok: false, detail: `${action.target} is not editable` };
      }
      if (action.submit) {
        await sleep(80);
        pressKey("Enter", el);
      }
      return { ok: true, detail: `typed into ${action.target}${action.submit ? " + Enter" : ""}` };
    }

    if (type === "select") {
      if (!(el instanceof HTMLSelectElement)) {
        pointerSequence(el);
        return { ok: true, detail: `opened ${action.target} (custom dropdown)` };
      }
      const want = (action.text || "").toLowerCase().trim();
      const opt =
        [...el.options].find((o) => o.text.toLowerCase().trim() === want || o.value.toLowerCase() === want) ||
        [...el.options].find((o) => o.text.toLowerCase().includes(want));
      if (!opt) return { ok: false, detail: `no option matching "${action.text}"` };
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, detail: `selected "${opt.text}"` };
    }

    return { ok: false, detail: `unsupported action ${type}` };
  }

  // ------------------------------------------------------------------ entry

  async function handle(cmd) {
    switch (cmd.op) {
      case "scan":
        return {
          url: location.href,
          title: document.title,
          viewport: {
            w: innerWidth,
            h: innerHeight,
            dpr: devicePixelRatio,
            scrollY: Math.round(scrollY),
            docH: Math.round(document.documentElement.scrollHeight),
          },
          elements: scanElements(),
          ...(() => {
            const names = cmd.names === false ? [] : findNames();
            return { names, pii: scanPii(cmd.known, names) };
          })(),
          images: scanImages(),
          challenge: detectChallenge(),
          autofill: detectAutofill(),
        };
      case "challenge":
        return detectChallenge();
      case "autofill":
        return detectAutofill();
      case "quiet-point":
        return quietPoint();
      case "point":
        return pointFor(cmd.tag);
      case "readback":
        return readback(cmd.tag);
      case "upload":
        return uploadTo(cmd.tag, cmd.file);
      case "paste": {
        // Paste into the focused editor: editors insert pasted text verbatim
        // (no auto-indent or auto-closing brackets, unlike typed text).
        const t = document.activeElement;
        if (!t || t === document.body || t.closest(challengeElSelector())) return { handled: false };
        const dt = new DataTransfer();
        dt.setData("text/plain", cmd.text);
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
        t.dispatchEvent(ev);
        return { handled: ev.defaultPrevented };
      }
      case "focus": {
        const el = elementMap.get(cmd.tag);
        if (el && !el.closest(challengeElSelector())) el.focus();
        return !!el;
      }
      case "inspect":
        return inspect(cmd.tag);
      case "execute":
        return execute(cmd.action);
      case "overlay":
        setOverlay(cmd);
        return true;
      case "overlay-remove":
        removeOverlay();
        return true;
      default:
        return { error: `unknown op ${cmd.op}` };
    }
  }

  window.__stellar = { handle };
})();
