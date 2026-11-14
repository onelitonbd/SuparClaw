// Human-friendly model display names, shared by the chat composer's model menu
// and Settings' model dropdowns: "kilo/minimax/minimax-m3.1-flash:free" reads as
// "Kilo Minimax Minimax M3.1 Flash Free". The stored value never changes — only
// what a human sees.

/** Drop a redundant provider prefix, then title-case every word separator. */
export function friendlyModelName(label: string, provider?: string): string {
  let short = label;
  if (provider && provider !== "default") {
    const prefix = provider + "/";
    if (short.toLowerCase().startsWith(prefix.toLowerCase())) short = short.slice(prefix.length);
  }
  const words = short
    .replace(/[\/:_-]+/g, " ")
    .split(/\s+/)
    .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim();
  return words || short;
}
