export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state-block">
      <div className="state-block__title">{title}</div>
      {hint ? <div className="state-block__hint">{hint}</div> : null}
    </div>
  );
}
