export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ width: '100%', maxWidth: 420, padding: '8px 0' }} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}
