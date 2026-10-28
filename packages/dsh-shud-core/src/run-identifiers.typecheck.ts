// Checked by the normal core typecheck; excluded from emitting builds.
// Keep outside schemas/, whose modules are imported during schema generation.
import {
  createBrandedId,
  DataProvenanceSchema,
  EvidenceReportSchema,
  generateRunIdentifiers,
  JobRecordIdSchema,
  PiGateDecisionSchema,
  RunIdSchema,
  RunJobSchema,
  StackLockSchema,
  TaskCardSchema,
  type DataId,
  type DataProvenance,
  type DecisionId,
  type EvidenceReport,
  type JobRecordId,
  type PiGateDecision,
  type RunId,
  type ReportId,
  type StackId,
  type StackLock,
  type TaskId,
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

const generatedTask: TaskId = createBrandedId("TASK");
const generatedStack: StackId = createBrandedId("STACK");
const generatedData: DataId = createBrandedId("DATA");
const generatedReport: ReportId = createBrandedId("REPORT");
const generatedDecision: DecisionId = createBrandedId("DEC");
// @ts-expect-error Plain strings are not task ids.
const plainTask: TaskId = "TASK-20261027T080005-3f9c";
// @ts-expect-error Plain strings are not stack ids.
const plainStack: StackId = "STACK-20261027T080005-a1b2";
// @ts-expect-error Plain strings are not data ids.
const plainData: DataId = "DATA-20261027T081000-7d2e";
// @ts-expect-error Plain strings are not report ids.
const plainReport: ReportId = "REPORT-20261027T090000-5b10";
// @ts-expect-error Plain strings are not decision ids.
const plainDecision: DecisionId = "DEC-20261027T093012-c4e7";
// @ts-expect-error Stack ids cannot be assigned to task ids.
const crossedTask: TaskId = createBrandedId("STACK");
// @ts-expect-error Data ids cannot be assigned to stack ids.
const crossedStack: StackId = createBrandedId("DATA");
// @ts-expect-error Report ids cannot be assigned to data ids.
const crossedData: DataId = createBrandedId("REPORT");
// @ts-expect-error Decision ids cannot be assigned to report ids.
const crossedReport: ReportId = createBrandedId("DEC");
// @ts-expect-error Task ids cannot be assigned to decision ids.
const crossedDecision: DecisionId = createBrandedId("TASK");

const card = TaskCardSchema.parse(stored);
const cardTask: TaskId = card.task_id;
const cardStack: StackId | null = card.stack_id;
const cardData: DataId | null = card.data_id;
const cardJobs: JobRecordId[] = card.linked_jobs;
const cardReports: ReportId[] = card.linked_reports;
const nullStack: typeof card.stack_id = null;
const nullData: typeof card.data_id = null;

const stackLock = StackLockSchema.parse(stored);
const parsedStackLockId: StackId = stackLock.stack_id;
// @ts-expect-error Plain strings cannot be assigned to the public StackLock stack_id field.
const plainStackLockId: StackLock["stack_id"] = "STACK-20261027T080000-3f9a";

const dataProvenance = DataProvenanceSchema.parse(stored);
const parsedDataProvenanceId: DataId = dataProvenance.data_id;
// @ts-expect-error Plain strings cannot be assigned to the public DataProvenance data_id field.
const plainDataProvenanceId: DataProvenance["data_id"] = "DATA-20261027T081000-7d2e";

const report = EvidenceReportSchema.parse(stored);
const reportId: ReportId = report.report_id;
const reportTask: TaskId = report.task_id;
const reportRuns: RunId[] = report.linked_runs;
const reportStacks: StackId[] = report.stack_ids;
const reportData: DataId[] = report.data_ids;
// @ts-expect-error Plain strings cannot be assigned to the public EvidenceReport report_id field.
const plainReportId: EvidenceReport["report_id"] = "REPORT-20261027T090000-5b10";
// @ts-expect-error Plain strings cannot be assigned to the public EvidenceReport task_id field.
const plainReportTask: EvidenceReport["task_id"] = "TASK-20261027T080005-3f9c";
// @ts-expect-error Plain strings cannot be assigned to public EvidenceReport linked_runs elements.
const plainReportRun: EvidenceReport["linked_runs"][number] = "RUN-20261027T082000-a1b2";
// @ts-expect-error Plain strings cannot be assigned to public EvidenceReport stack_ids elements.
const plainReportStack: EvidenceReport["stack_ids"][number] = "STACK-20261027T080000-a1b2";
// @ts-expect-error Plain strings cannot be assigned to public EvidenceReport data_ids elements.
const plainReportData: EvidenceReport["data_ids"][number] = "DATA-20261027T081000-7d2e";

const decision = PiGateDecisionSchema.parse(stored);
const decisionId: DecisionId = decision.decision_id;
const decisionReport: ReportId = decision.report_id;
// @ts-expect-error Plain strings cannot be assigned to the public PiGateDecision decision_id field.
const plainDecisionId: PiGateDecision["decision_id"] = "DEC-20261027T093012-c4e7";
// @ts-expect-error Plain strings cannot be assigned to the public PiGateDecision report_id field.
const plainDecisionReport: PiGateDecision["report_id"] = "REPORT-20261027T090000-5b10";

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
  generatedTask,
  generatedStack,
  generatedData,
  generatedReport,
  generatedDecision,
  plainTask,
  plainStack,
  plainData,
  plainReport,
  plainDecision,
  crossedTask,
  crossedStack,
  crossedData,
  crossedReport,
  crossedDecision,
  cardTask,
  cardStack,
  cardData,
  cardJobs,
  cardReports,
  nullStack,
  nullData,
  parsedStackLockId,
  plainStackLockId,
  parsedDataProvenanceId,
  plainDataProvenanceId,
  reportId,
  reportTask,
  reportRuns,
  reportStacks,
  reportData,
  plainReportId,
  plainReportTask,
  plainReportRun,
  plainReportStack,
  plainReportData,
  decisionId,
  decisionReport,
  plainDecisionId,
  plainDecisionReport,
];
