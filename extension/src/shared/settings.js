export const api = globalThis.browser ?? globalThis.chrome;

export const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8771",
  backend: "kokoro",
  voice: "",   // empty = server default for the backend
  speed: 1.0,
};

export async function getSettings() {
  const stored = await api.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export function setSettings(patch) {
  return api.storage.local.set(patch);
}
