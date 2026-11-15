// Progressive-enhancement haptics. Android Chrome: Vibration API. iOS Safari 18+: the
// hidden <input switch> trick (one system tick, only inside a real user gesture).
// Desktop: nothing. Never carries meaning on its own.

let enabled = true;
export function setHaptics(on: boolean) {
  enabled = on;
}

const canVibrate = typeof navigator !== "undefined" && "vibrate" in navigator;

export function buzz(pattern: number | number[]) {
  if (!enabled || !canVibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

let iosLabel: HTMLLabelElement | null = null;
/** Call only from a pointer/click handler. */
export function tapHaptic() {
  if (!enabled) return;
  if (canVibrate) return buzz(8);
  try {
    if (!iosLabel) {
      iosLabel = document.createElement("label");
      iosLabel.setAttribute("aria-hidden", "true");
      iosLabel.style.cssText = "position:fixed;left:-9999px;opacity:0;pointer-events:none";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      iosLabel.appendChild(input);
      document.body.appendChild(iosLabel);
    }
    iosLabel.click();
  } catch {
    /* ignore */
  }
}
