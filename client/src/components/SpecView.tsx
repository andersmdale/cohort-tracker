import schemaSql from '../../../server/sql/schema.sql?raw';
import studiesYaml from '../../../shared/studies.yaml?raw';
import planYaml from '../../../shared/plan.yaml?raw';
import { useState } from 'react';

const workerExample = `# A worker per execution environment claims runs for its engines and reports back
npm run worker -- --engines "slurm,nextflow:*" --name hpc-login-1

POST /api/workflow-runs/claim        {"worker": "hpc-login-1", "engines": ["slurm", "nextflow:*"]}
  → 200 {"runId": 812, "kind": "processing", "engine": "nextflow:abcd-dmri",
          "command": "qsiprep --output-resolution 1.7", "sessionIds": [...], "unitIds": [...]}
  → 204 when nothing is queued

POST /api/workflow-runs/812/finish   {"worker": "hpc-login-1", "status": "succeeded",
                                      "failed_unit_ids": [5512], "reason_code": "QC_MOTION"}`;

const apiExample = `POST /api/events
Content-Type: application/json

{
  "pipeline_id": "abcd-dmri",
  "step_key": "auto_qc",
  "session_ids": ["ABCD/P0000123/ses-1"],
  "to_state": "failed",
  "actor": "nextflow:mri-preproc@3.2.0",
  "software_version": "3.2.0",
  "reason_code": "QC_MOTION",
  "note": "mean FD 2.7 mm"
}

# to_state: running | passed | failed | queued | excluded
# "passed" advances units to the next step (or releases them after the last one).`;

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="panel">
      <div className="panel-head"><h2>{title}</h2><button className="btn sm" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
      <pre>{code}</pre>
    </div>
  );
}

export function SpecView() {
  return (
    <div className="stack">
      <div className="panel prose">
        <h2>How it fits together</h2>
        <p>
          Studies are configured in <span className="mono">shared/studies.yaml</span>: shared defaults per data type, overridden per study and
          per modality (steps, engines, commands, review deadlines, who launches each step, batch sizes, concurrency, retries and the team).
          Deliverables live in <span className="mono">shared/plan.yaml</span>: dependencies on other deliverables and on pipeline progress,
          an accountable owner with RACI roles, and work items that are either assigned to a person or run an automatable workflow.
          A scheduler in the server launches processing runs, review batches and deliverable workflows as soon as their dependencies are met.
        </p>
        <div className="flowline">
          <span>dependencies met</span><em>→</em><span>scheduler queues run or batch</span><em>→</em><span>worker or person</span>
          <em>→</em><span>finish / decision</span><em>→</em><span>event + NOTIFY</span><em>→</em><span>SSE</span><em>→</em><span>dashboard</span>
        </div>
      </div>
      <CodeBlock title="Study configuration · shared/studies.yaml" code={studiesYaml} />
      <CodeBlock title="Deliverables plan · shared/plan.yaml" code={planYaml} />
      <CodeBlock title="Workers" code={workerExample} />
      <CodeBlock title="External engines report progress" code={apiExample} />
      <CodeBlock title="Postgres schema" code={schemaSql} />
    </div>
  );
}
