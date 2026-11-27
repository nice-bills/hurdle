/** Re-mounts on every navigation, so each route fades and rises in (CSS, 320 ms, never blocks input). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
