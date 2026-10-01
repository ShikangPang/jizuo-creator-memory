import { z } from "zod";
import { ToolArgsError, type ParameterPropertySpec, type ValueSchemaSpec, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { JizuoError } from "@jizuo/contracts";

type Schema = Record<string, unknown>;

export function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, name: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const wrapped = input !== null && typeof input === "object" && !Array.isArray(input);
  const issues = parsed.error.issues.map(issue => {
    let actual: unknown = input;
    for (const key of issue.path) actual = actual !== null && typeof actual === "object" ? (actual as Record<PropertyKey, unknown>)[key] : undefined;
    const received = actual === undefined ? "缺失" : actual === null ? "null" : typeof actual === "object" ? Array.isArray(actual) ? "数组" : "对象" : String(JSON.stringify(actual)).slice(0, 120);
    return { path: ["input", ...issue.path].join("."), received, message: issue.message };
  });
  throw new JizuoError("model_repair", `${name} 参数校验失败：${wrapped ? "input 包装正确，请修正以下字段。" : "业务参数必须放在 input 对象内，不能传字符串或数组。"}${issues.map(issue => `${issue.path}（当前值：${issue.received}）：${issue.message}`).join("；")}。只修正报错字段，保留其他已确认内容。`, { issues });
}

/** Keep actionable Zod diagnostics when DSH rejects shape before execute. Never
 * retry execution: an error from a paid operation must not submit a second call. */
export function withToolInputRepair(definition: ToolDefinition, schema: z.ZodType): ToolDefinition {
  return { ...definition, execute: async (args, exec) => {
    try { return await definition.execute(args, exec); }
    catch (error) {
      if (error instanceof ToolArgsError) parseToolInput(schema, (args as { input?: unknown } | null)?.input, definition.name);
      throw error;
    }
  } };
}

function disjoint(left: Schema, right: Schema): boolean {
  if (typeof left.type === "string" && typeof right.type === "string" && left.type !== right.type) {
    return ![left.type, right.type].every(type => type === "number" || type === "integer");
  }
  if ("const" in left && "const" in right) return left.const !== right.const;
  if (left.type === "object" && right.type === "object") {
    const a = (left.properties ?? {}) as Record<string, Schema>;
    const b = (right.properties ?? {}) as Record<string, Schema>;
    return Object.keys(a).some(key => (left.required as string[] | undefined)?.includes(key)
      && (right.required as string[] | undefined)?.includes(key) && b[key] && disjoint(a[key]!, b[key]!));
  }
  return false;
}

/** DSH uses its own author DSL, not raw JSON Schema. Both 0.1.7 and 0.2.0
 * require per-property required:true and explicit object openness. Constraints
 * outside that DSL (lengths, ranges, refinements) remain enforced by Zod at execution.
 * Never advertise a string fallback or parse JSON strings into privileged inputs.
 */
export function toolInputSchema(schema: z.ZodType, description: string): ParameterPropertySpec {
  const project = (node: Schema): ValueSchemaSpec => {
    if ("$ref" in node || "allOf" in node) throw new Error("Tool input schema cannot contain references or intersections");
    const annotations = typeof node.description === "string" ? { description: node.description } : {};
    const branches = (node.anyOf ?? node.oneOf) as Schema[] | undefined;
    if (branches) {
      // Translating overlapping anyOf to exact-one would reject valid inputs.
      if (node.anyOf && branches.some((left, i) => branches.slice(i + 1).some(right => !disjoint(left, right)))) {
        throw new Error("Tool input unions must have disjoint types or required literal discriminators");
      }
      if (branches.length < 2) throw new Error("Tool input union requires at least two branches");
      return { ...annotations, oneOf: branches.map(project) as [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] };
    }
    switch (node.type) {
      case "object": {
        const required = new Set((node.required ?? []) as string[]);
        return {
          ...annotations, type: "object", additionalProperties: node.additionalProperties !== false,
          properties: Object.fromEntries(Object.entries((node.properties ?? {}) as Record<string, Schema>)
            .map(([key, value]) => [key, { ...project(value), ...(required.has(key) ? { required: true as const } : {}) }])),
        };
      }
      case "array":
        return { ...annotations, type: "array", ...(node.items ? { items: project(node.items as Schema) } : {}) };
      case "string": case "number": case "integer": case "boolean": case "null":
        return { ...annotations, type: node.type, ...("const" in node ? { const: node.const } : {}), ...(node.enum ? { enum: node.enum } : {}) } as ValueSchemaSpec;
      default:
        throw new Error(`Unsupported tool input schema type: ${String(node.type)}`);
    }
  };
  // Input projection keeps defaulted fields optional, matching Zod's accepted input.
  const projected = project(z.toJSONSchema(schema, { io: "input" }) as Schema);
  const isObject = (value: ValueSchemaSpec): boolean => "oneOf" in value
    ? value.oneOf.every(isObject) : value.type === "object";
  if (!isObject(projected)) throw new Error("Tool input must be an object");
  return { ...projected, required: true, description };
}
