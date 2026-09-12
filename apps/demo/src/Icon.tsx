const paths = {
  arrow: "M5 12h14m-6-6 6 6-6 6", plus: "M12 5v14M5 12h14", file: "M7 3h7l4 4v14H6V3m8 0v5h5M9 12h6M9 16h6",
  shield: "m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Zm-4 9 3 3 5-6", check: "m5 12 4 4L19 6",
  restore: "M4 10a8 8 0 1 1 1 8M4 4v6h6", external: "M14 4h6v6m0-6L10 14M10 4H4v16h16v-6",
  folder: "M3 7V5h6l2 2h10v13H3V7Z", chat: "M4 4h16v12H9l-5 4V4Z", close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16", leaf: "M20 4C8 2 2 8 6 16c8 4 14-2 14-12ZM6 18l9-9", warning: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
} as const;
export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
