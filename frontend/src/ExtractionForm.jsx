import { useState } from "react";
import { api } from "./api";

export default function ExtractionForm({ onSubmitted }) {
  const [documentType, setDocumentType] = useState("earnings release");
  const [documentText, setDocumentText] = useState("");
  const [status, setStatus] = useState({ text: "", kind: "" });

  async function handleSubmit() {
    const text = documentText.trim();
    if (!text) {
      setStatus({ text: "documentText is required", kind: "error" });
      return;
    }

    setStatus({ text: "Submitting...", kind: "" });
    try {
      const job = await api.submitJob({ type: "extraction", input: { documentText: text, documentType: documentType.trim() } });
      setStatus({ text: `Submitted — jobId ${job.jobId} (status: ${job.status})`, kind: "ok" });
      onSubmitted(job.jobId, "extraction");
    } catch (err) {
      setStatus({ text: `Error: ${err.message}`, kind: "error" });
    }
  }

  return (
    <section className="panel">
      <h2>Submit extraction job</h2>
      <label htmlFor="ex-type">Document type</label>
      <input
        type="text"
        id="ex-type"
        value={documentType}
        onChange={(e) => setDocumentType(e.target.value)}
        placeholder="earnings release, earnings call transcript, ..."
      />
      <label htmlFor="ex-text">Document text</label>
      <textarea
        id="ex-text"
        value={documentText}
        onChange={(e) => setDocumentText(e.target.value)}
        placeholder="Paste the earnings release / call transcript text here..."
      />
      <div className="row">
        <button className="primary" onClick={handleSubmit}>Submit extraction job</button>
        <span className={`status-line ${status.kind}`}>{status.text}</span>
      </div>
    </section>
  );
}
