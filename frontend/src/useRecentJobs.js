import { useCallback, useState } from "react";

const RECENT_KEY = "financeAgentJobQueue.recentJobs";

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

export function useRecentJobs() {
  const [jobs, setJobs] = useState(loadRecent);

  const addRecent = useCallback((jobId, type) => {
    setJobs((prev) => {
      const next = [{ jobId, type, at: new Date().toISOString() }, ...prev.filter((j) => j.jobId !== jobId)].slice(0, 20);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { jobs, addRecent };
}
