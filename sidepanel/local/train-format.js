// Prompt/answer formats shared by the on-device planner and the training-data
// exporter, so a model fine-tuned on the exported data sees exactly the
// prompts it will get at run time.

const ACTION_HELP = "click TAG | type TAG TEXT | type+enter TAG TEXT | select TAG OPTION | scroll up|down | press KEY | navigate URL | back | done ANSWER";

function elementLine(e) {
  const st = [];
  if (e.inputType && e.inputType !== "text") st.push(e.inputType);
  if (e.filled !== undefined) st.push(e.filled ? "filled" : "empty");
  if (e.checked !== undefined) st.push(e.checked ? "checked" : "unchecked");
  if (e.disabled) st.push("disabled");
  if (e.sensitive) st.push("secret field");
  if (e.options?.length) st.push(`options: ${e.options.slice(0, 8).join(" | ")}${e.options.length > 8 ? " | …" : ""}; selected: ${e.selected || "?"}`);
  return `${e.tag} "${e.label}"${st.length ? ` (${st.join("; ")})` : ""}`;
}

/** Compact single-turn prompt: the whole decision in ~300–600 tokens. */
export function compactPrompt({ task, host, elements, history, vaultTags, hiddenTags }) {
  return [
    `Goal: ${task}`,
    host ? `Page: ${host}` : null,
    "Elements:",
    ...elements.slice(0, 60).map(elementLine),
    `Vault tags (type these to fill the user's details): ${vaultTags.length ? vaultTags.map((t) => `[${t}]`).join(", ") : "none"}`,
    hiddenTags?.length ? `Hidden private data on screen: ${hiddenTags.slice(0, 12).map((t) => `[${t}]`).join(", ")}` : null,
    `Done so far: ${history.length ? history.slice(-6).map((h) => (h.text || h).replace(/^Step \d+: /, "")).join("; ") : "nothing yet"}`,
    `Next action? One line: ${ACTION_HELP}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Gemini's structured action -> the one-line answer format. */
export function compactAnswer(a) {
  switch (a?.type) {
    case "click":
      return `click ${a.target}`;
    case "type":
      return `${a.submit ? "type+enter" : "type"} ${a.target} ${a.text ?? ""}`.trim();
    case "select":
      return `select ${a.target} ${a.text ?? ""}`.trim();
    case "scroll":
      return `scroll ${a.direction || "down"}`;
    case "press_key":
      return `press ${a.key || "Enter"}`;
    case "navigate":
      return `navigate ${a.url}`;
    case "go_back":
      return "back";
    case "done":
      return `done ${a.final_answer || ""}`.trim();
    case "ask_user":
      return `ask ${a.final_answer || ""}`.trim();
    case "wait":
      return "wait";
    default:
      return null;
  }
}

/** Parse a one-line answer back into an action object (for a fine-tuned model). */
export function parseCompactAnswer(line) {
  const s = String(line || "").trim().split("\n")[0];
  let m;
  if ((m = s.match(/^click\s+([A-Z]+_\d{2})/i))) return { type: "click", target: m[1].toUpperCase() };
  if ((m = s.match(/^type(\+enter)?\s+([A-Z]+_\d{2})\s+(.+)$/i))) return { type: "type", target: m[2].toUpperCase(), text: m[3], submit: !!m[1] };
  if ((m = s.match(/^select\s+([A-Z]+_\d{2})\s+(.+)$/i))) return { type: "select", target: m[1].toUpperCase(), text: m[2] };
  if ((m = s.match(/^scroll\s+(up|down)/i))) return { type: "scroll", direction: m[1].toLowerCase() };
  if ((m = s.match(/^press\s+(\w+)/i))) return { type: "press_key", key: m[1] };
  if ((m = s.match(/^navigate\s+(\S+)/i))) return { type: "navigate", url: m[1] };
  if (/^back\b/i.test(s)) return { type: "go_back" };
  if ((m = s.match(/^done\s*(.*)$/i))) return { type: "done", final_answer: m[1] };
  return null;
}
