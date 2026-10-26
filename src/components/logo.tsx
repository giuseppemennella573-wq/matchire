/** The flame from the Matchire.ai logo, drawn so it sits over a dotless "ı". */
export function Flame() {
  return (
    <svg viewBox="0 0 10 14" aria-hidden="true">
      <path d="M5 0C6.5 3 9.5 5 9.5 9a4.5 4.5 0 0 1-9 0C.5 6.5 2.5 5 3 2.5 4 4 4.3 4.6 5 5.2 5.2 3.4 5.3 1.8 5 0z" fill="#EF5439" />
      <path d="M5 6.5c1 1.2 2 2 2 3.4a2 2 0 0 1-4 0c0-1.1.9-1.9 2-3.4z" fill="#F7C9A0" />
    </svg>
  );
}

/** The Matchire.ai wordmark, drawn in text so it stays sharp and follows the theme. */
export function Logo({ href = "/", style }: { href?: string; style?: React.CSSProperties }) {
  return (
    <a className="logo" href={href} style={style} aria-label="Matchire.ai">
      <span aria-hidden="true">Match<span className="logo-i">ı<Flame /></span>re.ai</span>
    </a>
  );
}
