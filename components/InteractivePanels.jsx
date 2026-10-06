"use client";
const cx = (...values) => values.filter(Boolean).join(" ");
const prettyDate = value => value ? new Date(value).toLocaleString() : "Unknown";
export function LearningPanel({ memory }) {
  const events = memory.learningEvents || [];
  const memoryWrites = events.filter((event) => event.type === "memory").length;
  const skillWrites = events.filter((event) => event.type === "skill").length;
  return (
    <section className="learningLayout">
      <section className="heroGrid">
        <div className="stat cyan"><span>Learning events</span><strong>{events.length}</strong></div>
        <div className="stat purple"><span>Memory writes</span><strong>{memoryWrites}</strong></div>
        <div className="stat green"><span>Skill updates</span><strong>{skillWrites}</strong></div>
        <div className="stat"><span>Last update</span><strong>{events[0]?.updatedAt?.slice(5, 16).replace("T", " ") || "none"}</strong></div>
      </section>
      <section className="learningTimeline">
        {events.length ? events.map((event) => (
          <article className={cx("learningCard", event.type)} key={event.id}>
            <div>
              <h2>{event.title}</h2>
              <span>{prettyDate(event.updatedAt)}</span>
            </div>
            <p>{event.summary}</p>
            <div className="learningMeta">
              <code>{event.source}</code>
              <code>{event.sessionTitle}</code>
              {event.model ? <code>{event.model}</code> : null}
              <code>{event.target}</code>
            </div>
          </article>
        )) : (
          <div className="empty">
            <strong>No self-learning writes found yet.</strong>
            <p>When Hermes uses the memory tool or updates a reusable skill, the change will appear here with the session and timestamp.</p>
          </div>
        )}
      </section>
    </section>
  );
}
