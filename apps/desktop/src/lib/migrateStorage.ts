// Preferences saved before the rename to StoreGenie Pro used "cf." keys; copy them over once.
try {
  for (const k of Object.keys(localStorage)) {
    const next = "sg." + k.slice(3);
    if (k.startsWith("cf.") && localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k)!);
  }
} catch {
  /* storage unavailable */
}

export {};
