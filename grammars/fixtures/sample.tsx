// TSX fixture: generics next to JSX tags, the classic ambiguity case.
import { useEffect, useRef, type ReactNode } from "react";

interface PanelProps<T> {
  title: string;
  rows: readonly T[];
  render: (row: T, index: number) => ReactNode;
}

export function Panel<T extends { id: string }>({ title, rows, render }: PanelProps<T>) {
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [rows]);

  return (
    <div ref={box} className="panel" role="region" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <span>{rows.length as number} rows</span>
      </header>
      {rows.map((row, i) => (
        <div key={row.id}>{render(row, i)}</div>
      ))}
    </div>
  );
}

const identity = <T,>(value: T): T => value;
export const empty: JSX.Element = <Panel title={identity("none")} rows={[]} render={() => null} />;
