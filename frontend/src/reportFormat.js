export function renderReportMarkdown(report) {
  const lines = [];
  lines.push(`# ${report.companyName || "Untitled"}${report.fiscalPeriodCovered ? " — " + report.fiscalPeriodCovered : ""}`, "");
  if (report.executiveSummary) {
    lines.push("## Executive Summary", "", report.executiveSummary, "");
  }
  for (const section of report.sections || []) {
    lines.push(`## ${section.heading}`, "", section.content, "");
  }
  if (report.sourcesUsed && report.sourcesUsed.length) {
    lines.push("## Sources", "", ...report.sourcesUsed.map((s) => `- ${s}`), "");
  }
  return lines.join("\n");
}

export function downloadReportMarkdown(report) {
  const markdown = renderReportMarkdown(report);
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const safeName = (report.companyName || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName || "report"}-research-report.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
