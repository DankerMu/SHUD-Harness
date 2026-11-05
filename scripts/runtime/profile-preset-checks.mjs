import { isDeepStrictEqual } from "node:util";

const coordinatorDelegations = [
  ["tool-subagent", "subagent", "worker"],
  ["tool-subagent-coder", "subagent_coder", "coder"],
  ["tool-subagent-reviewer", "subagent_reviewer", "reviewer"],
];

function presetChildIds(role) {
  return [
    "persona",
    "agent-instructions",
    "time-context",
    ...(role === "coder"
      ? ["tool-fs", "tool-bash"]
      : role === "reviewer"
        ? ["tool-fs", "tool-jobs"]
        : ["tool-jobs"]),
    ...(role === "coordinator" ? coordinatorDelegations.map(([id]) => id) : []),
  ];
}

export function coordinatorDelegationErrors(rows) {
  const errors = [];
  const require = (label, condition) => {
    if (!condition) errors.push(label);
  };
  const coordinators = Array.isArray(rows)
    ? rows.filter((row) => row?.id === "preset-coordinator")
    : [];
  require("preset-coordinator: unique enabled preset", coordinators.length === 1 &&
    coordinators[0]?.name === "@deepseek-ai/dsh-agent-preset" &&
    coordinators[0]?.disabled !== true);
  const plugins = coordinators[0]?.config?.plugins;
  const delegates = Array.isArray(plugins)
    ? plugins.filter(
        (row) =>
          row?.name === "@deepseek-ai/dsh-tool-subagent" || row?.id?.startsWith("tool-subagent"),
      )
    : [];
  const expected = coordinatorDelegations;
  require("preset-coordinator: exactly three delegation rows in order", isDeepStrictEqual(
    delegates.map((row) => row.id),
    expected.map(([id]) => id),
  ));
  require("preset-coordinator: exactly three same-package delegation rows", delegates.filter(
    (row) => row.name === "@deepseek-ai/dsh-tool-subagent",
  ).length === 3);
  for (const [id, toolName, agentPreset] of expected) {
    const matches = delegates.filter((row) => row.id === id),
      child = matches[0];
    require(`preset-coordinator/${id}: identity/status`, matches.length === 1 &&
      child?.name === "@deepseek-ai/dsh-tool-subagent" &&
      child.disabled !== true);
    require(`preset-coordinator/${id}: config`, isDeepStrictEqual(child?.config, {
      provider: "spawn",
      toolName,
      agentPreset,
      modelSelectionSettings: false,
    }));
  }
  return errors;
}

export function presetErrors(rows, schema, headless = false) {
  const errors = [],
    all = [];
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && (value.id || value.name)) all.push({ row: value, depth });
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  for (const row of rows) visit(row);
  const require = (label, condition) => {
    if (!condition) errors.push(label);
  };
  function global(id, name, disabled = false) {
    const matches = all.filter(({ row }) => row.id === id || row.name === name);
    const globals = matches.filter(({ depth }) => depth === 0);
    require(`${id}: unique global`, globals.length === 1 &&
      !matches.some(({ depth }) => depth > 0));
    const row = globals[0]?.row;
    require(`${id}: identity/status`, row?.id === id &&
      row?.name === name &&
      (row?.disabled === true) === disabled);
    const entries = schema["x-cordis"]?.entries?.filter((entry) => entry.id === id) ?? [];
    require(`${id}: import`, entries.length === 1 &&
      ["absent", "schema"].includes(entries[0]?.status));
    return row;
  }
  const restrict = global("shud-role-restrict", "@shud-harness/dsh-shud-presets");
  require("shud-role-restrict: no config", restrict !== undefined &&
    !Object.hasOwn(restrict, "config"));
  const coderApproval = global(
    "shud-coder-approval",
    "@shud-harness/dsh-shud-presets/coder-approval",
  );
  require("shud-coder-approval: no config", coderApproval !== undefined &&
    !Object.hasOwn(coderApproval, "config"));
  for (const id of ["subagent", "subagent-spawn-in-process"]) {
    const row = global(id, `@deepseek-ai/dsh-${id}`);
    require(`${id}: host config`, isDeepStrictEqual(
      row?.config,
      id === "subagent" ? undefined : { providerName: "spawn" },
    ));
  }
  const registries = all.filter(
    ({ row }) =>
      row.id === "agent-preset-registry" || row.name === "@deepseek-ai/dsh-agent-preset-registry",
  );
  require("preset default", headless
    ? registries.length === 0
    : registries.length === 1 &&
        registries[0].depth === 0 &&
        registries[0].row.name === "@deepseek-ai/dsh-agent-preset-registry" &&
        registries[0].row.disabled !== true &&
        registries[0].row.config?.default === "coordinator");
  const roles = ["coordinator", "worker", "coder", "reviewer"];
  for (const role of roles) {
    const id = `preset-${role}`,
      matches = all.filter(
        ({ row }) =>
          row.id === id ||
          (row.name === "@deepseek-ai/dsh-agent-preset" && row.config?.id === role),
      );
    const preset = matches[0]?.row,
      plugins = preset?.config?.plugins;
    require(`${id}: unique global/status`, matches.length === 1 &&
      matches[0].depth === 0 &&
      preset.id === id &&
      preset.name === "@deepseek-ai/dsh-agent-preset" &&
      (preset.disabled === true) === headless);
    require(`${id}: config`, preset?.config?.id === role &&
      (role !== "coordinator" || preset?.config?.order === 1) &&
      isDeepStrictEqual(
        Object.keys(preset?.config ?? {}).sort(),
        role === "coordinator" ? ["id", "order", "plugins"] : ["id", "plugins"],
      ));
    const ids = presetChildIds(role);
    require(`${id}: child order`, Array.isArray(plugins) &&
      isDeepStrictEqual(
        plugins.map((row) => row?.id),
        ids,
      ));
    for (const childId of ids) {
      const child = plugins?.find?.((row) => row?.id === childId);
      const delegation = coordinatorDelegations.find(([id]) => id === childId);
      const name = delegation ? "@deepseek-ai/dsh-tool-subagent" : `@deepseek-ai/dsh-${childId}`;
      require(`${id}/${childId}: identity/status`, child?.name === name && child.disabled !== true);
      const prefix = `process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@shud-harness/dsh-shud-presets/prompts/${role}.md'),'utf8')`;
      const config =
        childId === "persona"
          ? { prefix }
          : childId === "agent-instructions"
            ? { maxBytes: 65536 }
            : delegation
              ? {
                  provider: "spawn",
                  toolName: delegation[1],
                  agentPreset: delegation[2],
                  modelSelectionSettings: false,
                }
              : childId === "tool-fs"
                ? { read: true, readImage: false, write: false, edit: role === "coder" }
                : undefined;
      const actual =
        childId === "persona" && typeof child?.config?.prefix === "string"
          ? {
              ...child.config,
              prefix: child.config.prefix.replace(/('[^']*'|"[^"]*")|\s+/g, (text, literal) =>
                literal ? text.replace(/"/g, "'") : "",
              ),
            }
          : child?.config;
      require(`${id}/${childId}: config`, isDeepStrictEqual(actual, config));
    }
    const entries = schema["x-cordis"]?.entries?.filter((entry) => entry.id === id) ?? [];
    require(`${id}: import`, entries.length === 1 && entries[0]?.status === "schema");
  }
  require("no records plugin", !all.some(
    ({ row }) => row.id === "shud-records" || row.name === "@shud-harness/dsh-shud-records",
  ));
  const owned = rows.filter((row) =>
    [
      "preset-coordinator",
      "preset-worker",
      "preset-coder",
      "preset-reviewer",
      "shud-role-restrict",
      "shud-coder-approval",
    ].includes(row.id),
  );
  require("no preset machine paths", !/["'](?:\/[^/]|[A-Za-z]:\\\\)/.test(JSON.stringify(owned)));
  return errors;
}
export function checkPresets(check, rows, schema, label, headless = false) {
  const errors = presetErrors(rows, schema, headless);
  check(`${label}: presets: ${errors.join("; ")}`, errors.length === 0);
  let controls = 0,
    seamControls = 0;
  function reject(kind, mutate, expected, seamExpected) {
    const copy = globalThis.structuredClone(rows),
      projection = globalThis.structuredClone(schema),
      before = JSON.stringify([copy, projection]);
    try {
      mutate(copy, projection);
    } catch {
      check(`${label}: ${kind} mutation prerequisites`, false);
    }
    check(`${label}: ${kind} actually mutated`, JSON.stringify([copy, projection]) !== before);
    check(`${label}: rejects ${kind}`, presetErrors(copy, projection, headless).includes(expected));
    if (seamExpected && !headless) {
      check(
        `${label}: delegation seam rejects ${kind}`,
        coordinatorDelegationErrors(copy).includes(seamExpected),
      );
      seamControls++;
    }
    controls++;
  }
  const find = (rows, id) => rows.find((row) => row.id === id);
  const roles = ["coordinator", "worker", "coder", "reviewer"];
  if (headless)
    reject(
      "headless default",
      (rows) => rows.push({ id: "agent-preset-registry", config: { default: "coordinator" } }),
      "preset default",
    );
  else
    for (const value of [undefined, "worker", "coder", "reviewer"])
      reject(
        `default ${value ?? "missing"}`,
        (rows) => {
          find(rows, "agent-preset-registry").config.default = value;
        },
        "preset default",
      );
  for (const id of [
    "shud-role-restrict",
    "shud-coder-approval",
    "subagent",
    "subagent-spawn-in-process",
    ...roles.map((role) => `preset-${role}`),
  ]) {
    const identity = `${id}: ${id.startsWith("preset-") ? "unique global/status" : "identity/status"}`;
    for (const kind of ["missing", "duplicate", "nested", "disabled", "wrong-name"])
      reject(
        `${id} ${kind}`,
        (rows) => {
          const index = rows.findIndex((row) => row.id === id),
            row = find(rows, id);
          if (!row) throw new Error("missing mutation target");
          if (kind === "missing") rows.splice(index, 1);
          if (kind === "duplicate") rows.push(globalThis.structuredClone(row));
          if (kind === "nested") {
            rows.splice(index, 1);
            rows.push({ id: "negative-preset", config: { plugins: [row] } });
          }
          if (kind === "disabled") row.disabled = id.startsWith("preset-") ? !headless : true;
          if (kind === "wrong-name") row.name = "@invalid/wrong-package";
        },
        ["missing", "duplicate", "nested"].includes(kind)
          ? `${id}: ${id.startsWith("preset-") ? "unique global/status" : "unique global"}`
          : identity,
      );
    reject(
      `${id} import-error`,
      (_, schema) => {
        schema["x-cordis"].entries.find((entry) => entry.id === id).status = "error";
      },
      `${id}: import`,
    );
  }
  reject(
    "fixed restrict role",
    (rows) => {
      find(rows, "shud-role-restrict").config = { role: "coordinator" };
    },
    "shud-role-restrict: no config",
  );
  reject(
    "coder approval config",
    (rows) => {
      find(rows, "shud-coder-approval").config = { policy: "ask" };
    },
    "shud-coder-approval: no config",
  );
  for (const id of ["subagent", "subagent-spawn-in-process"])
    reject(
      `${id} maxDepth override`,
      (rows) => {
        const row = find(rows, id);
        row.config = { ...row.config, maxDepth: 2 };
      },
      `${id}: host config`,
    );
  for (const role of roles) {
    const id = `preset-${role}`;
    reject(
      `${id} wrong preset id`,
      (rows) => {
        find(rows, id).config.id = "standard";
      },
      `${id}: config`,
    );
    reject(
      `${id} reversed children`,
      (rows) => {
        find(rows, id).config.plugins.reverse();
      },
      `${id}: child order`,
    );
    const ids = presetChildIds(role);
    for (const childId of ids)
      for (const kind of ["missing", "extra", "disabled", "wrong-name", "wrong-config"])
        reject(
          `${id}/${childId} ${kind}`,
          (rows) => {
            const plugins = find(rows, id).config.plugins,
              index = plugins.findIndex((row) => row.id === childId),
              child = plugins[index];
            if (!child) throw new Error("missing mutation child");
            if (kind === "missing") plugins.splice(index, 1);
            if (kind === "extra")
              plugins.push({ id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" });
            if (kind === "disabled") child.disabled = true;
            if (kind === "wrong-name") child.name = "@invalid/wrong-child";
            if (kind === "wrong-config") child.config = { unexpected: true };
          },
          ["missing", "extra"].includes(kind)
            ? `${id}: child order`
            : `${id}/${childId}: ${kind === "wrong-config" ? "config" : "identity/status"}`,
          role === "coordinator" &&
            coordinatorDelegations.some(([id]) => id === childId) &&
            kind !== "extra"
            ? kind === "missing"
              ? "preset-coordinator: exactly three delegation rows in order"
              : `${id}/${childId}: ${kind === "wrong-config" ? "config" : "identity/status"}`
            : undefined,
        );
    const forbidden = [
      "shud-role-restrict",
      "subagent",
      "subagent-spawn-in-process",
      "tool-fs-search",
      "tool-skill",
      "skill-filesystem",
      "tool-subagent-control",
      "tool-ask-user",
      "tool-todo",
      "tool-web",
      "tool-schedule",
      "plan-mode",
      "compaction",
      "present",
      "tool-goal",
      ...(role === "coordinator" || role === "worker"
        ? ["tool-fs", "tool-bash"]
        : role === "coder"
          ? ["tool-jobs"]
          : ["tool-bash"]),
      ...(role === "coordinator" ? [] : coordinatorDelegations.map(([id]) => id)),
    ];
    for (const childId of forbidden)
      reject(
        `${id} forbidden ${childId}`,
        (rows) => {
          const name =
            childId === "shud-role-restrict"
              ? "@shud-harness/dsh-shud-presets"
              : coordinatorDelegations.some(([id]) => id === childId)
                ? "@deepseek-ai/dsh-tool-subagent"
                : `@deepseek-ai/dsh-${childId}`;
          find(rows, id).config.plugins.push({ id: childId, name });
        },
        `${id}: child order`,
      );
    if (role === "coder" || role === "reviewer") {
      reject(
        `${id} order`,
        (rows) => {
          find(rows, id).config.order = 2;
        },
        `${id}: config`,
      );
      for (const [field, value] of [
        ["read", false],
        ["readImage", true],
        ["write", true],
        ["edit", role !== "coder"],
      ]) {
        reject(
          `${id}/tool-fs ${field} ${value ? "enabled" : "disabled"}`,
          (rows) => {
            find(rows, id).config.plugins.find((row) => row.id === "tool-fs").config[field] = value;
          },
          `${id}/tool-fs: config`,
        );
        reject(
          `${id}/tool-fs missing ${field}`,
          (rows) => {
            delete find(rows, id).config.plugins.find((row) => row.id === "tool-fs").config[field];
          },
          `${id}/tool-fs: config`,
        );
      }
      reject(
        `${id} machine path`,
        (rows) => {
          find(rows, id).path = "/Users/profile-control";
        },
        "no preset machine paths",
      );
    }
  }
  for (const [childId] of coordinatorDelegations) {
    const diagnostic = `preset-coordinator/${childId}: config`;
    for (const [field, value] of [
      ["provider", "fork"],
      ["toolName", "delegate"],
      ["agentPreset", undefined],
      ["modelSelectionSettings", true],
      ["maxDepth", 2],
    ]) {
      const kind =
        childId === "tool-subagent"
          ? "coordinator delegation"
          : `coordinator ${childId} delegation`;
      reject(
        `${kind} ${field}`,
        (rows) => {
          find(rows, "preset-coordinator").config.plugins.find((row) => row.id === childId).config[
            field
          ] = value;
        },
        diagnostic,
        diagnostic,
      );
    }
    for (const field of ["toolName", "agentPreset"])
      reject(
        `coordinator ${childId} duplicate ${field}`,
        (rows) => {
          const plugins = find(rows, "preset-coordinator").config.plugins;
          const other = plugins.find(
            (row) => row.id !== childId && coordinatorDelegations.some(([id]) => id === row.id),
          );
          plugins.find((row) => row.id === childId).config[field] = other.config[field];
        },
        diagnostic,
        diagnostic,
      );
  }
  for (const kind of ["duplicate", "fourth"])
    reject(
      `coordinator ${kind} delegation`,
      (rows) => {
        const plugins = find(rows, "preset-coordinator").config.plugins;
        const extra = globalThis.structuredClone(plugins.find((row) => row.id === "tool-subagent"));
        if (kind === "fourth") {
          extra.id = "tool-subagent-extra";
          extra.config.toolName = "subagent_extra";
          extra.config.agentPreset = "standard";
        }
        plugins.push(extra);
      },
      "preset-coordinator: child order",
      "preset-coordinator: exactly three delegation rows in order",
    );
  reject(
    "coordinator order",
    (rows) => {
      find(rows, "preset-coordinator").config.order = 2;
    },
    "preset-coordinator: config",
  );
  reject(
    "records plugin",
    (rows) => rows.push({ id: "shud-records", name: "@shud-harness/dsh-shud-records" }),
    "no records plugin",
  );
  reject(
    "preset machine path",
    (rows) => {
      find(rows, "preset-worker").path = "/Users/profile-control";
    },
    "no preset machine paths",
  );
  // Coder approval adds five identity/status mutations, one import error and one config mutation.
  check(`${label}: every preset negative control executed`, controls === (headless ? 287 : 290));
  check(
    `${label}: every delegation seam negative control executed`,
    seamControls === (headless ? 0 : 35),
  );
}
