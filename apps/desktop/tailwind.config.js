import typography from "@tailwindcss/typography";
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        sunken: "rgb(var(--sunken) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        added: "rgb(var(--added) / <alpha-value>)",
        changed: "rgb(var(--changed) / <alpha-value>)",
        removed: "rgb(var(--removed) / <alpha-value>)",
        side: "rgb(var(--side) / <alpha-value>)",
        close: "rgb(var(--close-fg) / <alpha-value>)",
      },
      // One corner setting (Settings → Appearance) scales every radius.
      borderRadius: {
        sm: "calc(var(--r) * 0.5)",
        DEFAULT: "calc(var(--r) * 0.67)",
        md: "var(--r)",
        lg: "calc(var(--r) * 1.33)",
        xl: "calc(var(--r) * 2)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: { "2xs": ["11px", "14px"] },
    },
  },
  plugins: [typography],
};
