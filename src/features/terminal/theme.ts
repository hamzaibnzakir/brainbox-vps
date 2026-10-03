import type { ITheme } from "@xterm/xterm";

export function terminalTheme(mode: "dark" | "light", accent: string): ITheme {
  if (mode === "light") {
    return {
      background: "#fbfbfd",
      foreground: "#1d1d28",
      cursor: accent,
      cursorAccent: "#ffffff",
      selectionBackground: accent + "40",
      selectionInactiveBackground: accent + "26",
      black: "#1d1d28",
      red: "#d92d3a",
      green: "#16a34a",
      yellow: "#b7791f",
      blue: "#3a5bd9",
      magenta: "#8b3fd9",
      cyan: "#0e8aa6",
      white: "#6b6b80",
      brightBlack: "#8a8aa0",
      brightRed: "#ef4444",
      brightGreen: "#22c55e",
      brightYellow: "#d69e2e",
      brightBlue: "#5b7cfa",
      brightMagenta: "#a855f7",
      brightCyan: "#06b6d4",
      brightWhite: "#2a2a38",
    };
  }
  return {
    background: "#0c0c13",
    foreground: "#e3e3ee",
    cursor: accent,
    cursorAccent: "#0c0c13",
    selectionBackground: accent + "55",
    selectionInactiveBackground: accent + "30",
    black: "#1b1b26",
    red: "#ff6b7a",
    green: "#5be49b",
    yellow: "#ffcf5c",
    blue: "#7c9cff",
    magenta: "#c49bff",
    cyan: "#5ad7f0",
    white: "#c9c9d6",
    brightBlack: "#5d5d75",
    brightRed: "#ff8b97",
    brightGreen: "#7ff0b4",
    brightYellow: "#ffe08a",
    brightBlue: "#9db5ff",
    brightMagenta: "#d8b9ff",
    brightCyan: "#86e6f7",
    brightWhite: "#ffffff",
  };
}
