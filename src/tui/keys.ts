// Raw-stdin key decoding. Termux/Terminal-friendly: no native key parser.

export type KeyName =
  | "enter"
  | "newline"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "escape"
  | "tab"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "ctrl-g"
  | "ctrl-p"
  | "ctrl-o"
  | "ctrl-t"
  | "ctrl-u"
  | "pageup"
  | "pagedown"
  | "char";

export interface KeyEvent {
  name: KeyName;
  ch?: string;
  ctrl?: boolean;
}

export function parseKeys(input: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;

    if (ch === "\x1b") {
      const rest = input.slice(i);
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        const final = csi[2];
        const map: Record<string, KeyName> = {
          A: "up",
          B: "down",
          C: "right",
          D: "left",
          H: "home",
          F: "end",
          "3~": "delete",
          "5~": "pageup",
          "6~": "pagedown",
          "1~": "home",
          "4~": "end",
        };
        const finalChar = csi[2] ?? "";
        const name = map[finalChar === "~" ? `${csi[1] ?? ""}~` : finalChar];
        if (name) events.push({ name });
        i += csi[0].length;
        continue;
      }
      // ESC followed by nothing => plain Escape
      events.push({ name: "escape" });
      i += 1;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") {
      events.push({ name: "enter" });
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\x0b" || ch === "\x0c") {
      // Some terminals send Ctrl+J as \n; treat \x0a/vertical tab as newline insert.
      events.push({ name: "newline" });
      i += 1;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      events.push({ name: "backspace" });
      i += 1;
      continue;
    }
    const ctrlMap: Record<number, KeyName> = {
      0x03: "ctrl-c",
      0x04: "ctrl-d",
      0x07: "ctrl-g",
      0x08: "backspace",
      0x0c: "ctrl-l",
      0x0f: "ctrl-o",
      0x10: "ctrl-p",
      0x14: "ctrl-t",
      0x15: "ctrl-u",
      0x17: "ctrl-u",
    };
    if (code < 0x20 && ctrlMap[code]) {
      events.push({ name: ctrlMap[code] as KeyName, ctrl: true });
      i += 1;
      continue;
    }
    if (ch === "\t") {
      events.push({ name: "tab" });
      i += 1;
      continue;
    }
    const cp = input.codePointAt(i) ?? 0;
    const glyph = String.fromCodePoint(cp);
    events.push({ name: "char", ch: glyph });
    i += glyph.length;
  }
  return events;
}