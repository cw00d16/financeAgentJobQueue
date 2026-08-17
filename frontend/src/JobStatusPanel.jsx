import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { downloadReportMarkdown } from "./reportFormat";

function ReportView({ report }) {
  return (
    <div className="report">
      <h3>{report.companyName || "Untitled"}{report.fiscalPeriodCovered ? ` — ${report.fiscalPeriodCovered}` : ""}</h3>
      {report.executiveSummary && <p>{report.executiveSummary}</p>}
      {(report.sections || []).map((section, i) => (
        <div key={i}>
          <h4>{section.heading}</h4>
          <p>{section.content}</p>
        </div>
      ))}
      {report.sourcesUsed && report.sourcesUsed.length > 0 && (
        <>
          <h4>Sources</h4>
          <ul>{report.sourcesUsed.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
    </div>
  );
}

export default function JobStatusPanel({ jobId, onJobIdChange, pendingCheck, pendingAutopoll }) {
  const [status, setStatus] = useState({ html: null, kind: "" });
  const [jobData, setJobData] = useState(null);
  const [autopoll, setAutopoll] = useState(false);
  const [reportView, setReportView] = useState("formatted");
  const lastCheckedJobIdRef = useRef(null);
  const pollTimerRef = useRef(null);

  async function checkJob(idOverride) {
    const id = (idOverride ?? jobId).trim();
    if (!id) {
      setStatus({ html: "Enter a job ID first", kind: "error" });
      return;
    }

    // Switching to a different job resets the view back to formatted —
    // otherwise it'd stay stuck on "Raw JSON" from whatever the last job left it at.
    if (id !== lastCheckedJobIdRef.current) {
      setReportView("formatted");
      lastCheckedJobIdRef.current = id;
    }

    setStatus({ html: "Checking...", kind: "" });
    try {
      const data = await api.getJob(id);
      setStatus({
        html: (
          <>
            <span className={`badge ${data.status}`}>{data.status}</span> {data.type} — last updated {new Date(data.updatedAt).toLocaleString()}
          </>
        ),
        kind: "",
      });
      setJobData(data);

      const terminal = data.status === "succeeded" || data.status === "failed";
      if (terminal && pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        setAutopoll(false);
      }
    } catch (err) {
      setStatus({ html: `Error: ${err.message}`, kind: "error" });
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        setAutopoll(false);
      }
    }
  }

  // checkJob (and jobId/pendingAutopoll) close over values that change
  // every render — stash the latest in a ref so the trigger effect below
  // can read them without listing them as dependencies. It must fire only
  // when the parent explicitly bumps pendingCheck (job submitted, recent
  // job clicked), never just because jobId changed from typing.
  const latestRef = useRef({ checkJob, jobId, pendingAutopoll });
  latestRef.current = { checkJob, jobId, pendingAutopoll };

  useEffect(() => {
    if (pendingCheck === 0) return;
    const { checkJob: fn, jobId: id, pendingAutopoll: shouldAutopoll } = latestRef.current;
    if (shouldAutopoll) setAutopoll(true);
    fn(id);
  }, [pendingCheck]);

  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (autopoll) {
      pollTimerRef.current = setInterval(() => latestRef.current.checkJob(), 3000);
    }
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [autopoll]);

  const hasReport = jobData?.status === "succeeded" && jobData?.type === "research" && jobData?.result;
  const effectiveView = hasReport ? reportView : "raw";

  return (
    <section className="panel">
      <h2>Check job status</h2>
      <label htmlFor="job-id">Job ID</label>
      <input
        type="text"
        id="job-id"
        value={jobId}
        onChange={(e) => onJobIdChange(e.target.value)}
        placeholder="paste a jobId or pick one from Recent jobs below"
      />
      <div className="row">
        <button className="primary" onClick={() => checkJob()}>Check now</button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: 0, color: "var(--text)", fontSize: 13 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={autopoll} onChange={(e) => setAutopoll(e.target.checked)} />
          auto-refresh every 3s until done
        </label>
        <span className={`status-line ${status.kind}`}>{status.html}</span>
      </div>

      {jobData && (
        <div className="row view-toggle">
          {hasReport && (
            <button
              className={`secondary small ${effectiveView === "formatted" ? "active" : ""}`}
              type="button"
              onClick={() => setReportView("formatted")}
            >
              Formatted
            </button>
          )}
          <button
            className={`secondary small ${effectiveView === "raw" ? "active" : ""}`}
            type="button"
            onClick={() => setReportView("raw")}
          >
            Raw JSON
          </button>
          {hasReport && (
            <button className="secondary small" type="button" onClick={() => downloadReportMarkdown(jobData.result)}>
              Download report
            </button>
          )}
        </div>
      )}

      {jobData && effectiveView === "formatted" && hasReport && <ReportView report={jobData.result} />}
      {jobData && effectiveView === "raw" && <pre className="result">{JSON.stringify(jobData, null, 2)}</pre>}
    </section>
  );
}
