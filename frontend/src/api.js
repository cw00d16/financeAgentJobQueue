const BASE = process.env.REACT_APP_API_URL;

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  submitJob: (body) => request("POST", "/jobs", body),
  getJob: (jobId) => request("GET", `/jobs/${encodeURIComponent(jobId)}`),
};
