// Chrome only: service workers cannot play audio, so the player lives here.
import { Player } from "../player/player.js";

const player = new Player((evt) => {
  chrome.runtime.sendMessage({ target: "background", ...evt }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  sendResponse(player.handle(msg));
  return false;
});
