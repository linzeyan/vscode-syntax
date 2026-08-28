// JSX fixture: tag names, attribute expressions, embedded expressions in children.
import React, { useState, useCallback } from "react";

export function TodoList({ items, onToggle }) {
  const [filter, setFilter] = useState("all");
  const visible = items.filter((it) => filter === "all" || it.done === (filter === "done"));

  const toggle = useCallback((id) => () => onToggle(id), [onToggle]);

  return (
    <section className="todo-list" data-count={visible.length}>
      <h1>Todos ({visible.length})</h1>
      <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        {["all", "open", "done"].map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <ul>
        {visible.map((it) => (
          <li key={it.id} className={it.done ? "done" : undefined}>
            <input type="checkbox" checked={it.done} onChange={toggle(it.id)} />
            {it.title}
          </li>
        ))}
      </ul>
      {visible.length === 0 && <p>Nothing here.</p>}
    </section>
  );
}
