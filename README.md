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

---

## Install (2 minutes)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`Stellar-extension`).
4. Pin the ⭐ Stellar icon. Click it (or press **Alt+Shift+S**) to open the side panel.
5. Click the ⚙ gear → paste one or more **Gemini API keys**, comma-separated
   (from [aistudio.google.com](https://aistudio.google.com/apikey)) → **Test key & load models** → **Save**.
   Rejected or rate-limited keys are rotated out automatically, like Stellar's key manager.

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
- **Smooth follow & guided pace**: while a task runs, the panel glides to each new card (no jumps) and the newest card glows briefly. Scroll up to read and following pauses — press **↓ Follow live** or scroll to the bottom to resume. With **Settings → Pace → Guided** (default) each stage stays on screen for about a second before the next one starts, so people can follow along; choose **Fast** for full speed.
- **Theme**: follows your system light/dark setting; the ◐ button in the header cycles System → Light → Dark.

### Demo page

`demo/index.html` is a fictional "Orbit Cloud" account page full of fake
credentials (API keys, card number, Aadhaar/PAN, password field, email, phone).
Serve it locally and try **Snapshot**, then a task such as
*"Open a support ticket about account access using my vault details"*:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765/demo/index.html>. (Opening it as a `file://` URL
also works if you enable **Allow access to file URLs** for the extension.)

Put this in **Settings → Private vault** to see tag substitution in action:

```
NAME=Aarav Sharma
EMAIL=aarav.sharma@example.com
```

The model only ever sees `[VAULT_NAME]` / `[VAULT_EMAIL]`; the real values are typed
in locally after validation — and re-redacted on the next frame.

---

## What each stage does

| # | Stage | Where | Implementation |
| --- | --- | --- | --- |
| 1 | **Capture** | on-device | `chrome.tabs.captureVisibleTab` + a DOM scan that tags every visible interactive element (`[BUTTON_03]`, `[INPUT_02]`, `[LINK_07]`…) — Set-of-Marks style. |
| 2 | **Detect** | on-device + vision | **DOM rules** (local): password/OTP/card/autofill fields, and regexes over visible text for emails, phones, cards (Luhn-checked), Aadhaar, PAN, API keys/JWTs, and your vault values. **Gemini vision** (optional): names, addresses, faces, text inside images — returned as `box_2d` boxes. The two are merged. |
| 3 | **Redact** | on-device | Canvas masks each region (solid or blur) and stamps its semantic tag. The same value always gets the same tag. |
| 4 | **Send** | → cloud | Only the sanitized JPEG + a scrubbed prompt (element labels, scrubbed URL/title, previous actions). A **leak check** blocks the request if any known private value appears in the outbound text. |
| 5 | **Reason** | cloud | Gemini returns one JSON action: `click / type / select / scroll / press_key / navigate / go_back / wait / done / ask_user`. |
| 6 | **Validate** | on-device | Allow-list, target must be a real visible enabled element from this frame, tags resolved to real values locally, unknown tags blocked, tags never substituted into URLs (exfiltration guard), loop detection, and **user approval** for risky actions (pay / delete / submit / send / vault fills / typing into password fields). |
| 7 | **Execute** | on-device | Content script performs the action on the real element (framework-safe value setting, full pointer sequence, Enter-to-submit), follows newly opened tabs, waits for the page to settle, loops. |

### Privacy note on the vision detector

In the original design the detector runs on-device (ONNX Runtime Web / WebGPU).
For simplicity this build uses **Gemini as the detector**, which means the *raw*
frame is sent to Gemini for that one call. The panel labels this stage as
"local + vision". If you need the raw frame to never leave the machine, choose
**Settings → PII detection → DOM only** — Snapshot then makes zero network calls,
and Run sends only the sanitized frame. Swapping in an on-device model only
requires replacing the `detector === "vision"` block in `sidepanel/agent.js`.

---

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
demo/index.html          fictional page with fake PII for demos
icons/                   extension icons
```

## Limitations

- Chrome blocks extensions on `chrome://` pages, the Web Store and some PDFs.
- Cross-origin iframes and closed shadow roots aren't scanned by the DOM layer
  (the vision detector still sees them; element tags won't exist for them).
- Canvas-only apps (Figma, Google Docs editor) expose few DOM elements to act on.
- Defaults: `gemini-3.6-flash` for reasoning, `gemini-3.5-flash-lite` for vision
  detection (2–4 s, and far less congested). If a model is overloaded (503),
  rate-limited or slow (>35 s), the client rotates through your keys, then falls
  back along `3.6-flash → 3.5-flash-lite → 3.7-flash → 3-flash-preview →
  3.1-flash-lite → 3.8-flash`, then backs off and retries. Use **Test key & load
  models** to see which keys work and pick any model.
