# Fine-tuning data for the on-device model

Gemini is the **teacher**, FastVLM-0.5B the **student**. Every Gemini-decided step is recorded as a
supervised example: the **sanitized** frame + a compact prompt → Gemini's action. Only what Gemini
already received is stored (masked frames, scrubbed text, tag-only actions such as `[VAULT_NAME]`),
never raw screenshots or vault values.

## Two ways to collect

1. **While using the extension** — Settings → *Training data* → tick *Record Gemini steps…*, use it
   normally, then *Export dataset (.zip)*.
2. **Automatically** — `datagen.js` drives the real extension through randomized pages (support tickets,
   sign-ups, shipping, job applications, appointments, help-centre search: varied labels, field order,
   layouts, decoy buttons, on-page PII, fake identities) plus live Wikipedia lookups, and **verifies each
   episode against ground truth** (the submitted form must contain the right vault values and choices).

```bash
npm i puppeteer
node training/datagen.js --episodes 60 --wiki 10 --seed 11 --out training/data
```

Requires `GEMINI_API_KEYS` in `.env`. Takes ~40–60 s per episode.

## What's in the zip

| File | Contents |
| --- | --- |
| `images/*.jpg` | sanitized frames (masked PII, Set-of-Marks element labels) |
| `llava_full.json` | LLaVA records: compact prompt → one-line action (`click TAG`, `type TAG TEXT`, `type+enter …`, `select TAG OPTION`, `scroll`, `navigate`, `done ANSWER`) |
| `llava_mcq.json` | the on-device planner's multiple-choice prompt → option number |
| `steps.jsonl` | full context per step: elements (options, form, rect), history, Gemini's observation/thought/action, validator verdict, result |
| `stats.json` | counts, action mix, planner shortlist hit-rate |

Only steps from successful (and, for generated pages, verified) episodes whose action passed the local
gate and executed are exported. Prompts come from `sidepanel/local/train-format.js` and
`sidepanel/local/planner.js` — the same code the extension runs — so a fine-tuned model sees identical
inputs at run time (`parseCompactAnswer()` reads its output).

## Fine-tuning (next step)

The records follow the LLaVA conversation format used by Apple's
[ml-fastvlm](https://github.com/apple/ml-fastvlm) training code. A practical recipe:

1. LoRA fine-tune `apple/FastVLM-0.5B` on `llava_mcq.json` first (small, fast, directly improves the
   current planner), then on `llava_full.json` to let the model choose actions without the heuristics.
2. Hold out ~10 % of episodes (split by episode, not by step) and report action accuracy.
3. Merge the LoRA weights, export to ONNX (vision encoder, embed tokens, decoder) with the same layout as
   `onnx-community/FastVLM-0.5B-ONNX`, quantize (q4f16 decoder, fp16 vision, uint8 embeddings) and point
   `MODEL_ID` in `sidepanel/local/vlm-worker.js` at the new repo.

Licences: the labels are Gemini outputs — review the Gemini API terms before training on them; FastVLM
weights are under Apple's model licence.
