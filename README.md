# Stellar — Privacy-First Visual Browser Agent (Chrome extension)

A Chrome extension for [stellarai.site](https://stellarai.site/) that implements the
SIH 2026 *STELLAR_6* idea (PS 26171 — *On-device Visual Perception for Light-Weight
Browser Agents*):

> **Capture → Detect → Redact → Reason → Validate → Execute**
> AI sees what it needs, and not what it shouldn't.

The agent looks at the current tab, replaces credentials and personal data with
semantic tags such as `[EMAIL_01]` / `[PASSWORD_01]`, sends **only the sanitized
frame** to Gemini, then validates the action Gemini proposes **locally** before
performing it in the page. Every stage is shown live in the side panel on the right,
so you can show people exactly what leaves the machine.

![pipeline](https://img.shields.io/badge/pipeline-capture→detect→redact→send→reason→validate→execute-7c3aed)

## ⬇️ Download

[![Download Stellar extension (.zip)](https://img.shields.io/badge/Download-Stellar%20extension%20(.zip)-7c3aed?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/manohar-munna/Stellar-extension/archive/refs/heads/main.zip)

**[Download the latest version (.zip)](https://github.com/manohar-munna/Stellar-extension/archive/refs/heads/main.zip)** —
always built from the newest commit on `main`, so it is never out of date.

---

## Install (2 minutes)

1. [Download the zip](https://github.com/manohar-munna/Stellar-extension/archive/refs/heads/main.zip) and
   unzip it. You get a folder named **`Stellar-extension-main`** (the one containing `manifest.json`).
   Keep it somewhere permanent — Chrome loads the extension from that folder.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `Stellar-extension-main` folder.
4. Pin the ⭐ Stellar icon. Click it (or press **Alt+Shift+S**) to open the side panel.
5. Click the ⚙ gear → paste one or more **Gemini API keys**, comma-separated
   (from [aistudio.google.com](https://aistudio.google.com/apikey)) → **Test keys & load models** → **Save**.
   Rejected or rate-limited keys are rotated out automatically, like Stellar's key manager.

**Updating:** download the zip again, replace the folder's contents, then click the ↻ reload icon on the
Stellar card in `chrome://extensions`. Settings and the vault are kept.

## Use it

| Button | What happens |
| --- | --- |
| **Snapshot** | Capture → Detect → Redact and show the exact payload that *would* be sent. No reasoning call — the best way to demo redaction. |
| **Run agent** | Full loop. Type a task (e.g. *"Search for wireless earbuds and open the cheapest result"*) and press **Run** (or Ctrl+Enter). |
| **Stop** | Aborts the in-flight Gemini call and stops the loop. |
| 👁 Presenter mode | Blurs raw captures inside the panel so you can screen-share safely. |
| ↗ Pop-out | Opens the panel in its own big window for projecting. It drives the last-focused browser window. |
| Export run | Downloads a JSON log of the run (sanitized frames only, never raw captures or private values). |

**Reading the panel**

- **Task tabs** (under Run/Snapshot): every task or snapshot gets its own tab — `Task 1`, `Task 2`, … — with a
  status dot (blue running · yellow needs you · green done · red stopped). Click to switch, × to close.
- **Stage rail** (left): the current step (`Step 3/15`) and all seven stages. The pulsing node is the stage running
  now; each node says where it runs — `DEVICE`, `+ CLOUD` (vision detector), `TO CLOUD`, `CLOUD`. Click a node to
  jump to that stage's card.
- **Steps**: finished steps fold into one line — action, ✓/✗, coloured stage dots and duration. Click to expand, or
  use *Expand all / Collapse all*. Cards are numbered by stage and edged green (on-device) or violet (cloud).
- **New Tab page**: Chrome blocks extensions on it, so Stellar opens google.com in that tab and starts from there.
- **CAPTCHAs / bot checks**: Stellar never solves them. When a Cloudflare Turnstile, reCAPTCHA, hCaptcha,
  Arkose or Cloudflare “Just a moment…” check is on screen, the agent pauses *before* any model call, shows a
  **Human verification needed** card and an on-page message, and resumes by itself as soon as the check is
  cleared (or when you click *I’ve done it — continue*). Model actions that target a CAPTCHA widget are blocked.
- **Continue a task**: every finished task ends with a *Continue this task* box. A follow-up runs in the same
  task card with the earlier steps and result as context (“now upload my résumé too”), also after reopening the
  panel.
- **Files in the private vault**: Settings → Private vault → *Add file…* with a toggle — **Extract details**
  (name, email… into the vault), **Store the file** (kept on this device for upload fields), or **Both** (best
  for a résumé). Stored files appear to the AI only as tags like `[FILE_RESUME]`; Stellar detects upload fields
  — also hidden ones behind a styled “Upload résumé” button — and attaches the file straight from this device
  with the `upload` action (it never opens the computer's file picker). Safe mode asks before uploading.
- **Pop-ups and new tabs**: Stellar follows a tab or “Sign in with Google” window a click opens, and when that
  window closes itself after signing in it carries on in the page that opened it.
- **Voice, any language**: press 🎤 in the task box and speak. Chrome's speech recognition types it live; the
  run starts 2 s later unless you click the box to edit. Chrome's recogniser writes everything in the
  language it listens in (Telugu comes out as Hindi if it listened in Hindi), so with *Auto* its text is only
  a live preview: Gemini then identifies the spoken language from the clip — including English words mixed
  into Telugu, Hindi, Tamil… — transcribes it, and Stellar remembers that language. Or pick a language from
  the menu to skip that check. Stellar answers in that language — typed non-English tasks too — and reads its
  questions and the result aloud with the browser's voice (Settings → Agent). For Local-first, the on-device
  planner gets an English copy of the task. The first time, a tab opens to allow the microphone (the side
  panel can't show that prompt). Note: Chrome's recogniser sends the audio to Google's speech service.
- **Real mouse & keyboard** (Settings → Agent, on by default): clicks, typing and keys go through Chrome's real
  input via the debugger protocol — the reason the extension asks for the `debugger` permission. That makes
  React/Vue-controlled fields, rich-text editors, custom dropdowns and buttons that ignore scripted events work.
  Typing is read back and falls back to scripted events if it didn't take; native `<select>` menus are set
  directly. Chrome shows a “started debugging this browser” bar while a task runs. **CAPTCHAs and bot checks
  are never clicked** — points on them are refused and the run hands over to you.
- **Autofilled logins**: Chrome fills saved logins on page load but hides the values from the site (and from
  extensions) until a *real* click — so a plain scripted Sign-in submits empty fields. Stellar spots these
  fields, masks them in the frame, and makes one real click on a blank part of the login form (never a button,
  field, link or CAPTCHA). With real input off, it asks you to click the page once instead. The password is
  never read or sent.
- **Smooth follow & guided pace**: while a task runs, the panel glides to each new card (no jumps) and the newest card glows briefly. Scroll up to read and following pauses — press **↓ Follow live** or scroll to the bottom to resume. With **Settings → Pace → Guided** (default) each stage stays on screen for about a second before the next one starts, so people can follow along; choose **Fast** for full speed.
- **Theme**: follows your system light/dark setting; the ◐ button in the header cycles System → Light → Dark.

### Demo page

`demo/` is a fictional "Orbit Cloud" site that works **fully offline** (no external
fonts, scripts or images) and has a page for every feature:

| Page | Shows |
|---|---|
| Dashboard | names/email/phone in text, a photo with a face (NASA, public domain) → on-device face blur |
| Profile | PAN, Aadhaar, DOB, address → semantic tags |
| Billing | card, CVV, bank account, IFSC → solid black; plan dropdown; *Delete account* (risky); a scanned receipt whose text is *inside an image* (only "+ Cloud vision" reads it) |
| Orders | a table to reason over ("which order is pending?") |
| Support | the ticket form (vault fill, dropdown, message, send) |
| Developers | `sk-…`, `AIza…`, `ghp_…`, a JWT and a Bearer token in a code block; a planted **prompt injection** asking the AI to paste the key |
| Careers | a long application form with required fields (phone is missing from the preset vault → Stellar asks and saves it) and a consent checkbox |
| Help centre | search → results → article (multi-page task, answer "14 days") |
| Security | filled password and OTP fields |
| Newsletter | a **simulated, offline** bot check, so the CAPTCHA pause → you tick → auto-resume can be shown without internet |
| Demo guide | the vault preset, copy buttons for every task, and sample files for vault import (`demo/samples/`: ID card PNG, scanned PDF, résumé .docx, contact .vcf — fictional people) |

```bash
python -m http.server 8765
```

Then open <http://localhost:8765/demo/> and start from **Demo guide**. (Opening it as a
`file://` URL also works if you enable **Allow access to file URLs** for the extension.)

Measured with Local-first + Autopilot (real Gemini, FastVLM on WebGPU):

| Task | On-device steps | Gemini calls | Time |
|---|---|---|---|
| Billing support ticket from the vault | 5 of 6 (Gemini: final check) | 1 | 13 s |
| Careers application, phone missing | asks once, then 12 of 13 on-device | 1 | 21 s |
| Switch plan to Basic | 2 of 3 | 1 | 17 s |
| Help-centre refund question | search on-device, Gemini opens the article and answers | 2 | 10 s |
| Feedback on a page with a prompt injection | 2 of 3, no key pasted | 1 | 10 s |
| Newsletter behind the bot check | pauses for you, then 2 of 3 on-device | 1 | 13 s |

The model only ever sees tags such as `[VAULT_NAME]` or `[API_KEY_01]`; real values are
typed in locally after validation, and they are redacted again on the next frame.

---

## What each stage does

| # | Stage | Where | Implementation |
| --- | --- | --- | --- |
| 1 | **Capture** | on-device | `chrome.tabs.captureVisibleTab` + a DOM scan that tags every visible interactive element (`[BUTTON_03]`, `[INPUT_02]`, `[LINK_07]`…) — Set-of-Marks style. |
| 2 | **Detect** | on-device | **DOM rules**: password/OTP/card/autofill fields, and regexes over visible text for emails, phones, cards (Luhn-checked), Aadhaar, PAN, API keys/JWTs, and your vault values. **On-device face detection** (MediaPipe BlazeFace, WebAssembly) over the whole frame and zoomed into every visible image. *Optional comparison mode:* Gemini vision also looks for names, addresses and text in images — this sends the unredacted frame, so it is off by default. |
| 3 | **Redact** | on-device | Per PS 26171: **faces blurred** (pixelated + blurred), **passwords, keys, OTPs, cards and IDs blacked out**, **other PII masked** — each stamped with its semantic tag. The same value always gets the same tag. |
| 4 | **Send** | → cloud | Only the sanitized JPEG + a scrubbed prompt (element labels, scrubbed URL/title, previous actions). A **leak check** blocks the request if any known private value appears in the outbound text. |
| 5 | **Reason** | cloud | Gemini returns one JSON action: `click / type / select / scroll / press_key / navigate / go_back / wait / done / ask_user`. |
| 6 | **Validate** | on-device | Allow-list, target must be a real visible enabled element from this frame, tags resolved to real values locally, unknown tags blocked, tags never substituted into URLs (exfiltration guard), loop detection, and **user approval** for risky actions (pay / delete / submit / send / vault fills / typing into password fields). |
| 7 | **Execute** | on-device | Content script performs the action on the real element (framework-safe value setting, full pointer sequence, Enter-to-submit), follows newly opened tabs, waits for the page to settle, loops. |

### No network request before redaction

By default nothing leaves the machine until the frame is redacted, as PS 26171 requires: detection is DOM rules
plus on-device face detection, and a Snapshot makes **zero** network requests. **Settings → PII detection →
+ Cloud vision** adds Gemini as an extra detector for comparison; it sends the *unredacted* frame for that one call,
and the panel labels the stage "local + cloud vision".

---

## On-device model (backup) and vault import

**FastVLM-0.5B** (Apple, ONNX via Transformers.js) runs in a Web Worker on **WebGPU** (WASM fallback). Open
**Settings → On-device model → Download & load** once: about 670 MB, cached by the browser, roughly a minute the
first time on a fast connection. Do this before a demo.

**Who decides each step** (Settings → On-device model):

| Mode | What happens |
| --- | --- |
| **Local-first** (default) | Each step: **capture + label** (element tags drawn on the frame) → the on-device model tries. If it is sure — a determined fill (vault field, a message the task states, a matching dropdown option, a search term) or submitting the form it just filled — it acts **without redaction, because nothing leaves the device**. Otherwise **Detect → Redact → Send** run and Gemini decides on the sanitized frame. Links, results and menus are left to Gemini, and Gemini always does the **final verification** on a redacted frame. Demo billing task: 5 of 6 steps on-device (13 s); live Wikipedia: search on-device, reading and answer by Gemini (7 s). Each Gemini card says why the cloud was needed. |
| **Gemini-first** | Gemini decides every step; the on-device model takes over if Gemini fails, so the demo keeps going. |
| **On-device** | Nothing is sent to the cloud at all; FastVLM plans every step. Best for form-style tasks. |
| **Gemini only** | No on-device decisions. |

**Safe / Autopilot** (the switch next to *Run agent*):

| Mode | What happens |
| --- | --- |
| **Safe** | Asks before risky clicks (pay, delete, submit, send), vault fills and pasting secrets. |
| **Autopilot** | Runs to the end without approval prompts. It still stops for real questions — a required field your vault can't fill, or a CAPTCHA — and it still *blocks* (never auto-approves) pasting an on-page password/key into an ordinary field and putting secrets into URLs. |

**Missing details:** if a required field (`required`, `aria-required` or a trailing `*`) needs personal data your vault
doesn't have, Stellar asks you once. The answer is saved to the vault (on by default) and from then on the AI only
sees it as a tag such as `[VAULT_PHONE]` — the value never appears in what is sent to Gemini.

How the backup plans: a 0.5B model cannot plan a whole task alone, so the extension narrows each step to the five
most relevant actions (skipping finished ones, filling a form before its submit button, matching dropdown options and
vault fields to the task) and FastVLM chooses between them while looking at the **sanitized** frame. Free text comes
from the task when it says what to write ("asking to downgrade my plan"), otherwise FastVLM drafts it.

Model choice was benchmarked in Chromium on WebGPU: SmolVLM-256M and SmolVLM-500M could not pick actions or read an
ID card; FastVLM-0.5B read a test ID card 6/6 in about 1.5 s. Weights use fp16 vision + 4-bit decoder + 8-bit
embeddings: same accuracy as the model card's ~1.1 GB setup at ~670 MB.

**Import vault data from files** (Settings → Private vault → *Add file…*): *Extract with Gemini instead* is **on by
default** — Gemini reads the file (it is uploaded to Google for that), which is the most accurate for résumés and
scans. Switch it off to read everything on this device instead: ID-card photos and scanned PDFs by FastVLM, text
PDFs via pdf.js, and `.docx`, `.vcf`, `.txt`, `.csv` and `.json` parsed locally. Either way you review and edit every
field before it is saved.

## Project layout

```
manifest.json            MV3 manifest (side panel, scripting, tabs, storage)
background.js            opens the side panel on toolbar click / Alt+Shift+S
content/content.js       DOM element tagging, DOM PII detection, action executor, page overlay
sidepanel/
  sidepanel.html/.css/.js  the live pipeline UI, settings, approvals
  agent.js               the Capture→…→Execute loop
  gemini.js              Gemini REST client (generateContent, listModels)
  prompts.js             detector + agent prompts and JSON schemas
  privacy.js             region merging, semantic tags, scrubbing, leak check, tag substitution
  redact.js              canvas rendering of detection / sanitized frames
  validate.js            local action-validation gate
  settings.js            chrome.storage.local settings
  vault-import.js        vault extraction from images, PDFs, .docx, .vcf, text
  local/vlm-worker.js    FastVLM in a Web Worker (WebGPU / WASM)
  local/vlm.js           client: load with progress, generate
  local/planner.js       on-device backup planner
demo/                    offline demo site (fake PII, face photo, forms, bot check) + sample vault files
icons/                   extension icons
vendor/                  Transformers.js, ONNX Runtime Web, pdf.js (see vendor/README.md)
```

## Limitations

- Chrome blocks extensions on `chrome://` pages, the Web Store and some PDFs.
- Cross-origin iframes and closed shadow roots aren't scanned by the DOM layer
  (on-device face detection still covers the pixels; element tags won't exist for them).
- Canvas-only apps (Figma, Google Docs editor) expose few DOM elements to act on.
- Defaults: `gemini-3.6-flash` for reasoning, `gemini-3.5-flash-lite` for vision
  detection (2–4 s, and far less congested). If a model is overloaded (503),
  rate-limited or slow (>35 s), the client rotates through your keys, then falls
  back along `3.6-flash → 3.5-flash-lite → 3.7-flash → 3-flash-preview →
  3.1-flash-lite → 3.8-flash`, then backs off and retries. Use **Test key & load
  models** to see which keys work and pick any model.
