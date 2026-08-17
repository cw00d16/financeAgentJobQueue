import { useState } from "react";
import { api } from "./api";

let nextDocId = 1;

export default function ResearchForm({ onSubmitted }) {
  const [companyName, setCompanyName] = useState("");
  const [docs, setDocs] = useState([]);
  const [status, setStatus] = useState({ text: "", kind: "" });

  function addDoc() {
    setDocs((prev) => [...prev, { id: nextDocId++, documentType: "earnings release", documentText: "" }]);
  }

  function removeDoc(id) {
    setDocs((prev) => prev.filter((d) => d.id !== id));
  }

  function updateDoc(id, field, value) {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, [field]: value } : d)));
  }

  async function handleSubmit() {
    const name = companyName.trim();
    if (!name) {
      setStatus({ text: "companyName is required", kind: "error" });
      return;
    }

    const sourceDocuments = docs
      .map((d) => ({ documentType: d.documentType.trim(), documentText: d.documentText.trim() }))
      .filter((d) => d.documentText);

    setStatus({ text: "Submitting...", kind: "" });
    try {
      const job = await api.submitJob({ type: "research", input: { companyName: name }, sourceDocuments });
      setStatus({ text: `Submitted — jobId ${job.jobId} (status: ${job.status})`, kind: "ok" });
      onSubmitted(job.jobId, "research");
    } catch (err) {
      setStatus({ text: `Error: ${err.message}`, kind: "error" });
    }
  }

  return (
    <section className="panel">
      <h2>Submit research job</h2>
      <label htmlFor="rs-company">Company name</label>
      <input
        type="text"
        id="rs-company"
        value={companyName}
        onChange={(e) => setCompanyName(e.target.value)}
        placeholder="Acme Corp"
      />
      <label>Source documents (optional — extracted first, then fed into research)</label>
      <div>
        {docs.map((doc, index) => (
          <div className="source-doc" key={doc.id}>
            <div className="source-doc-header">
              <span className="title">Source document {index + 1}</span>
              <button className="secondary small" type="button" onClick={() => removeDoc(doc.id)}>Remove</button>
            </div>
            <label>Document type</label>
            <input
              type="text"
              value={doc.documentType}
              onChange={(e) => updateDoc(doc.id, "documentType", e.target.value)}
            />
            <label>Document text</label>
            <textarea
              value={doc.documentText}
              onChange={(e) => updateDoc(doc.id, "documentText", e.target.value)}
              placeholder="Paste source document text..."
            />
          </div>
        ))}
      </div>
      <div className="row">
        <button className="secondary small" type="button" onClick={addDoc}>+ Add source document</button>
      </div>
      <div className="row">
        <button className="primary" onClick={handleSubmit}>Submit research job</button>
        <span className={`status-line ${status.kind}`}>{status.text}</span>
      </div>
    </section>
  );
}
