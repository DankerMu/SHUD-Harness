import {
  ToolArgsError,
  type ParameterSchemaSpec,
  type ToolDefinition,
} from "@deepseek-ai/dsh-tools";

/** Close both the model-visible schema and rc.2 defineTool's captured open-root validator. */
export function strictTool(tool: ToolDefinition, parameters: ParameterSchemaSpec): ToolDefinition {
  return {
    ...tool,
    parameters: { ...tool.parameters, additionalProperties: false },
    execute(args, exec) {
      if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        const unknown = Object.keys(args).filter((key) => !Object.hasOwn(parameters, key));
        if (unknown.length > 0) {
          throw new ToolArgsError(unknown.map((key) => `Unknown parameter: ${key}`));
        }
      }
      return tool.execute(args, exec);
    },
  };
}
