import { createHash } from "node:crypto";

// Do not import the injected workspace package here. This tiny production
// verifier must be compiled from the exact source tree that owns the release.
import {
  BUILT_IN_WORKFLOW_DEFINITION,
  DEFAULT_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "../../workflow-runtime/src/definition.ts";
import { WorkflowHarnessManifest } from "../../workflow-runtime/src/harnessManifest.ts";
import { canonicalJson, sha256 } from "../../workflow-runtime/src/hash.ts";
import { validateWorkflowDefinition } from "../../workflow-runtime/src/invariants.ts";
import { defaultWorkflowRegistry } from "../../workflow-runtime/src/registry.ts";

export const BUILT_IN_WORKFLOW_CANONICAL_HASH = sha256(DEFAULT_WORKFLOW_DEFINITION);

const shippedWorkflows = Object.freeze({
  [BUILT_IN_WORKFLOW_DEFINITION.id]: Object.freeze({
    definition: BUILT_IN_WORKFLOW_DEFINITION,
    resource: WorkflowHarnessManifest.workflow,
  }),
});

export interface VerifiedShippedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly canonicalHash: string;
  readonly resourceHash: string;
}

/** Validates the frozen resource bytes and the code-owned default graph. */
export function verifyShippedWorkflowResource(bytes: Buffer | string): VerifiedShippedWorkflow {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Shipped workflow JSON is unreadable");
  }
  const validated = validateWorkflowDefinition(parsed, defaultWorkflowRegistry);
  if (!validated.ok) throw new Error("Shipped workflow fails production validation");
  const shipped = shippedWorkflows[validated.definition.id as keyof typeof shippedWorkflows];
  if (!shipped) throw new Error("Shipped workflow is not a registered built-in definition");
  const resourceHash = createHash("sha256").update(raw).digest("hex");
  if (resourceHash !== shipped.resource.sha256) throw new Error("Shipped workflow resource hash mismatch");
  const canonicalHash = sha256(validated.definition);
  if (
    canonicalHash !== sha256(shipped.definition)
    || canonicalJson(validated.definition) !== canonicalJson(shipped.definition)
  ) {
    throw new Error("Shipped workflow differs from the code-owned built-in definition");
  }
  return Object.freeze({ definition: validated.definition, canonicalHash, resourceHash });
}
