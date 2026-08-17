export default function RecentJobsList({ jobs, onSelect }) {
  return (
    <section className="panel">
      <h2>Recent jobs (this browser only)</h2>
      <ul className="recent">
        {jobs.length === 0 && <li style={{ color: "var(--muted)" }}>Nothing submitted yet.</li>}
        {jobs.map((j) => (
          <li key={j.jobId}>
            <span>
              <a onClick={() => onSelect(j.jobId)}>{j.jobId}</a> <span style={{ color: "var(--muted)" }}>({j.type})</span>
            </span>
            <span style={{ color: "var(--muted)" }}>{new Date(j.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
