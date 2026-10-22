// Checked by the normal core typecheck; excluded from emitting builds.
// Keep outside schemas/, whose modules are imported during schema generation.
import {
  generateRunIdentifiers,
  JobRecordIdSchema,
  RunIdSchema,
  RunJobSchema,
  type JobRecordId,
  type RunId,
} from "./index.ts";

const ids = generateRunIdentifiers();
declare const stored: unknown;
const job = RunJobSchema.parse(stored);
const generatedJob: JobRecordId = ids.job_id;
const generatedRun: RunId = ids.run_id;
const parsedJob: JobRecordId = JobRecordIdSchema.parse(stored);
const parsedRun: RunId = RunIdSchema.parse(stored);
const storedJob: JobRecordId = job.job_id;
const storedRun: RunId = job.run_id;
// @ts-expect-error Plain strings are not job record ids.
const plainJob: JobRecordId = "JOB-20261022T031500-a1b2";
// @ts-expect-error Plain strings are not run ids.
const plainRun: RunId = "RUN-20261022T031500-a1b2";
// @ts-expect-error Job record ids cannot be assigned to run ids.
const crossedRun: RunId = ids.job_id;
// @ts-expect-error Run ids cannot be assigned to job record ids.
const crossedJob: JobRecordId = ids.run_id;

void [
  generatedJob,
  generatedRun,
  parsedJob,
  parsedRun,
  storedJob,
  storedRun,
  plainJob,
  plainRun,
  crossedRun,
  crossedJob,
];
