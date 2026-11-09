// Independently authored input bytes and output oracle; no production serializer is used.
export const SUMMARY_PLAN_BYTES = [
  '{"analysis_plan_id":"PLAN-20261108T093000-5c1e","task_id":"TASK-20261102T090000-c3d4",',
  '"mode":"sensitivity","strategy":"one_at_a_time","input_dir":"/workspace/input/ccw","project":"ccw","end_days":90,"threads":1,',
  '"parameter_sets":[{"parameter_set_id":"PSET-1","label":null,"baseline":true,"changes":{}},',
  '{"parameter_set_id":"PSET-2","label":null,"baseline":false,"changes":{"GEOL_KSATH":2}},',
  '{"parameter_set_id":"PSET-3","label":null,"baseline":false,"changes":{"LC_ROUGH":2}}],',
  '"parameter_space_rationale":{"proposed_by":"agent","basis":"Single-key perturbations relative to the baseline.","confirmed_by":null},',
  '"input_digests":{"ccw.cfg.calib":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",',
  '"ccw.para.geol":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",',
  '"ccw.para.lc":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},',
  '"created_by":"coordinator","created_at":"2026-11-08T09:30:00Z"}\n',
].join("");

const metricsPrefix = [
  '{"method_version":"1","status":"ok","reason":null,"inputs":[{"path":"stderr.log",',
  '"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":12}],',
  '"nonfinite_count":0,"outlets":[1,2],',
].join("");
const metricsSuffix = [
  '"water_balance":{"formula_source":"rSHUD wb.all / wb.DS; SHUD snow/interception extension","P":0.1,"Qd":0.03,"AET":0.06,',
  '"delta_s_surf":0.001,"delta_s_us":0.002,"delta_s_gw":0.003,"delta_s_riv":0.001,"delta_s_snow":0.001,"delta_s_ic":0.001,"delta_s":0.009,"residual":0.01,',
  '"reasons":{"P":null,"Qd":null,"AET":null,"delta_s_surf":null,"delta_s_us":null,"delta_s_gw":null,"delta_s_riv":null,"delta_s_snow":null,"delta_s_ic":null,"delta_s":null,"residual":null},',
  '"approximation":"Final output interval average, not instantaneous final state"},',
  '"numerical_health":{"water_balance_residual":0.01,"cvode_failures":2,"negative_state_count":3,"max_solver_dt":null,',
  '"reasons":{"water_balance_residual":null,"cvode_failures":null,"negative_state_count":null,"max_solver_dt":"not_observable_in_pinned_shud"},',
  '"negative_state_count_note":"SHUD 静默钳零，该值为下界"},',
  '"verdicts":{"water_balance_residual":"pass","cvode_failures":"fail","negative_state_count":"warn"}}\n',
].join("");

export const BASELINE_METRICS_BYTES =
  metricsPrefix +
  '"flow":{"peak_flow_m3d":200,"peak_day":44,"total_runoff_m3":0,"reasons":{"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null}},' +
  metricsSuffix;
export const PERTURBED_METRICS_BYTES =
  metricsPrefix +
  '"flow":{"peak_flow_m3d":150,"peak_day":46,"total_runoff_m3":60,"reasons":{"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null}},' +
  metricsSuffix;

export const SUMMARY_PLAN_SHA256 =
  "5b2b8864f359d09c380296911cfcea89e98bcb9df940b63296b9733ddc246b07";
export const BASELINE_METRICS_SHA256 =
  "950cf636fb8b5e83f656858f206124f7c164550dcb1f43b1a9db214d7d843e01";
export const PERTURBED_METRICS_SHA256 =
  "fa259e428f51321fdf14a8b4fcd332a9022c5402f07d87bfa7e7b4f12e26b2f7";

// Hand calculation: (150 - 200) / 200 * 100 = -25; 46 - 44 = 2.
// Runoff's zero baseline has no percentage; the failed cell has no metric or delta.
// JOB-0002's failed attempt is superseded by JOB-0004, not a second PSET-2 row.
export const EXPECTED_SUMMARY_BYTES = [
  '{"method_version":"1","analysis_plan_id":"PLAN-20261108T093000-5c1e",',
  '"plan_sha256":"5b2b8864f359d09c380296911cfcea89e98bcb9df940b63296b9733ddc246b07",',
  '"task_id":"TASK-20261102T090000-c3d4","project":"ccw","end_days":90,"rows":[',
  '{"parameter_set_id":"PSET-1","label":null,"baseline":true,"key":null,"multiplier":null,',
  '"job_id":"JOB-20261108T093000-0001","run_id":"RUN-20261108T093000-0001","status":"succeeded","exit_code":0,"exit_class":"ok",',
  '"peak_flow_m3d":200,"peak_day":44,"total_runoff_m3":0,"water_balance_residual":0.01,"water_balance_residual_verdict":"pass",',
  '"metric_reasons":{"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null,"water_balance_residual":null},',
  '"delta_peak_flow_pct":null,"delta_peak_day":null,"delta_total_runoff_pct":null,',
  '"delta_reasons":{"delta_peak_flow_pct":"baseline_row","delta_peak_day":"baseline_row","delta_total_runoff_pct":"baseline_row"}},',
  '{"parameter_set_id":"PSET-2","label":null,"baseline":false,"key":"GEOL_KSATH","multiplier":2,',
  '"job_id":"JOB-20261108T093000-0004","run_id":"RUN-20261108T093000-0004","status":"succeeded","exit_code":0,"exit_class":"ok",',
  '"peak_flow_m3d":150,"peak_day":46,"total_runoff_m3":60,"water_balance_residual":0.01,"water_balance_residual_verdict":"pass",',
  '"metric_reasons":{"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null,"water_balance_residual":null},',
  '"delta_peak_flow_pct":-25,"delta_peak_day":2,"delta_total_runoff_pct":null,',
  '"delta_reasons":{"delta_peak_flow_pct":null,"delta_peak_day":null,"delta_total_runoff_pct":"zero_baseline"}},',
  '{"parameter_set_id":"PSET-3","label":null,"baseline":false,"key":"LC_ROUGH","multiplier":2,',
  '"job_id":"JOB-20261108T093000-0003","run_id":"RUN-20261108T093000-0003","status":"failed","exit_code":19,"exit_class":"cvode",',
  '"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null,"water_balance_residual":null,"water_balance_residual_verdict":null,',
  '"metric_reasons":{"peak_flow_m3d":"run_failed","peak_day":"run_failed","total_runoff_m3":"run_failed","water_balance_residual":"run_failed"},',
  '"delta_peak_flow_pct":null,"delta_peak_day":null,"delta_total_runoff_pct":null,',
  '"delta_reasons":{"delta_peak_flow_pct":"run_failed","delta_peak_day":"run_failed","delta_total_runoff_pct":"run_failed"}}],',
  '"superseded_runs":[{"parameter_set_id":"PSET-2","job_id":"JOB-20261108T093000-0002","run_id":"RUN-20261108T093000-0002","terminal_state":"collected","exit_class":"cvode"}],',
  '"inputs":[{"run_id":"RUN-20261108T093000-0001","metrics_sha256":"950cf636fb8b5e83f656858f206124f7c164550dcb1f43b1a9db214d7d843e01"},',
  '{"run_id":"RUN-20261108T093000-0004","metrics_sha256":"fa259e428f51321fdf14a8b4fcd332a9022c5402f07d87bfa7e7b4f12e26b2f7"}]}\n',
].join("");

export const EXPECTED_SUMMARY_SHA256 =
  "36688d69502e3bdc16eda18c7c714054ad6eab747c1f1887687a27bb63c59b27";
