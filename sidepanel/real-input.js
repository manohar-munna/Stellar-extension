// Real mouse and keyboard input through Chrome's debugger protocol.
//
// Scripted DOM events are "untrusted": some sites (React-controlled inputs
// with custom handlers, rich-text editors, custom dropdowns, buttons that check
// event.isTrusted) ignore them. Input sent through chrome.debugger goes through
// Chrome's real input pipeline, exactly like a person using the mouse and
// keyboard. The debugger is attached on first use and detached when the run
// ends; Chrome shows a "started debugging this browser" bar meanwhile.
//
// CAPTCHAs and bot checks are never clicked: the content script refuses any
// point that lands on one, and the validator blocks such targets earlier.

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export class RealInput {
  constructor() {
    this.tabId = null;
    this.attached = false;
    this.lost = false; // the user cancelled the debugger bar: stop using it this run
    this.onDetach = (source) => {
      if (source.tabId === this.tabId) {
        this.attached = false;
        this.lost = true;
      }
    };
  }

  get available() {
    return !!chrome.debugger && !this.lost;
  }

  async attach(tabId) {
    if (this.attached && this.tabId === tabId) return true;
    if (!this.available) return false;
    if (this.attached) await this.detach();
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.tabId = tabId;
      this.attached = true;
      chrome.debugger.onDetach.addListener(this.onDetach);
      return true;
    } catch {
      return false;
    }
  }

  async detach() {
    chrome.debugger?.onDetach.removeListener(this.onDetach);
    if (this.attached) await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    this.attached = false;
  }

  send(method, params) {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  async click(x, y) {
    const at = { x: Math.round(x), y: Math.round(y) };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 });
  }

  async key(name) {
    const k = KEYS[name] || KEYS.Enter;
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  }

  /** Select everything in the focused field and delete it. */
  async clearFocused() {
    const mod = navigator.platform.startsWith("Mac") ? 4 : 2; // Meta on macOS, Ctrl elsewhere
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: mod, commands: ["selectAll"] });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: mod });
    await this.key("Backspace");
  }

  /** Types into the focused element the way an IME commit does (trusted input events). */
  insertText(text) {
    return this.send("Input.insertText", { text });
  }
}
