import { useState } from "react";
import ExtractionForm from "./ExtractionForm.jsx";
import ResearchForm from "./ResearchForm.jsx";
import JobStatusPanel from "./JobStatusPanel.jsx";
import RecentJobsList from "./RecentJobsList.jsx";
import { useRecentJobs } from "./useRecentJobs";

export default function App() {
  const { jobs, addRecent } = useRecentJobs();
  const [jobId, setJobId] = useState("");
  const [pendingCheck, setPendingCheck] = useState(0);
  const [pendingAutopoll, setPendingAutopoll] = useState(false);

  function goToJob(id, { autopoll = false } = {}) {
    setJobId(id);
    setPendingAutopoll(autopoll);
    setPendingCheck((n) => n + 1);
  }

  function handleSubmitted(newJobId, type) {
    addRecent(newJobId, type);
    goToJob(newJobId, { autopoll: true });
  }

  return (
    <>
      <header>
        <h1>financeAgentJobQueue</h1>
        <p>Submit extraction/research jobs and check their status. Thin client over the job queue API — no auth, personal use.</p>
      </header>
      <main>
        <ExtractionForm onSubmitted={handleSubmitted} />
        <ResearchForm onSubmitted={handleSubmitted} />
        <JobStatusPanel
          jobId={jobId}
          onJobIdChange={setJobId}
          pendingCheck={pendingCheck}
          pendingAutopoll={pendingAutopoll}
        />
        <RecentJobsList jobs={jobs} onSelect={(id) => goToJob(id)} />
      </main>
    </>
  );
}
