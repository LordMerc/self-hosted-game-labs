import type { Page } from "./Nav";

let wanted = false;

/** Go to Settings and scroll to the Hide my IP card, which is easy to miss further down the page. */
export function openRelaySettings(navigate: (p: Page) => void) {
  wanted = true;
  navigate("settings");
}

/** True once after `openRelaySettings`. */
export function takeRelayFocus() {
  const was = wanted;
  wanted = false;
  return was;
}
