import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowDefinitionV2 } from "./definition.ts";
import type { WorkflowRegistry } from "./registry.ts";

export interface WorkflowValidationFailure {
  code: string;
  message: string;
}

export type WorkflowValidationResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; issues: readonly WorkflowValidationFailure[] };

type Graph = {
  nodeIds: Set<string>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
};

function graphFor(definition: WorkflowDefinition, includeEdge: (edge: WorkflowDefinition["edges"][number]) => boolean = () => true): Graph {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>([...nodeIds].map((id) => [id, []]));
  const incoming = new Map<string, string[]>([...nodeIds].map((id) => [id, []]));
  for (const edge of definition.edges) {
    if (!includeEdge(edge)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }
  return { nodeIds, outgoing, incoming };
}

/** Exact structural marker used only after the full invariant validator passes. */
export function supportsDirectChapterWrite(definition: WorkflowDefinition): boolean {
  if (definition.schemaVersion === 2) {
    const writeOutgoing = definition.edges.filter((edge) => edge.from === "write");
    return writeOutgoing.length === 1
      && writeOutgoing[0]?.to === "verify"
      && writeOutgoing[0]?.when === "always";
  }
  const create = definition.edges.filter((edge) => edge.when === "approvedCreateTarget");
  const modify = definition.edges.filter((edge) => edge.when === "approvedModifyTarget");
  const gateOutgoing = definition.edges.filter((edge) => edge.from === "review-gate");
  return create.length === 1
    && create[0]?.from === "review-gate"
    && create[0]?.to === "verify"
    && modify.length === 1
    && modify[0]?.from === "review-gate"
    && modify[0]?.to === "proposal"
    && gateOutgoing.length === 3
    && gateOutgoing.some((edge) => edge.to === "revise" && edge.when === "revisionAllowed")
    && !gateOutgoing.some((edge) => edge.when === "allRequiredReviewsPass");
}

function visit(start: string, edges: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of edges.get(current) ?? []) pending.push(next);
  }
  return visited;
}

function dominators(graph: Graph, entry: string): Map<string, Set<string>> {
  const all = new Set(graph.nodeIds);
  const result = new Map<string, Set<string>>();
  for (const id of graph.nodeIds) result.set(id, id === entry ? new Set([entry]) : new Set(all));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of graph.nodeIds) {
      if (id === entry) continue;
      const predecessors = graph.incoming.get(id) ?? [];
      const intersection = predecessors.length === 0
        ? new Set<string>()
        : predecessors.slice(1).reduce(
          (shared, predecessor) => new Set([...shared].filter((item) => result.get(predecessor)!.has(item))),
          new Set(result.get(predecessors[0]!)!),
        );
      intersection.add(id);
      const previous = result.get(id)!;
      if (previous.size !== intersection.size || [...previous].some((item) => !intersection.has(item))) {
        result.set(id, intersection);
        changed = true;
      }
    }
  }
  return result;
}

function stronglyConnectedComponents(graph: Graph): string[][] {
  let index = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visitNode = (node: string) => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.outgoing.get(node) ?? []) {
      if (!indexes.has(next)) {
        visitNode(next);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(next)!));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(next)!));
      }
    }
    if (lowLinks.get(node) === indexes.get(node)) {
      const component: string[] = [];
      while (true) {
        const child = stack.pop()!;
        onStack.delete(child);
        component.push(child);
        if (child === node) break;
      }
      components.push(component);
    }
  };
  for (const node of graph.nodeIds) if (!indexes.has(node)) visitNode(node);
  return components;
}

function hasCycle(graph: Graph, excludedEdges: (from: string, to: string) => boolean): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.outgoing.get(node) ?? []) {
      if (!excludedEdges(node, next) && walk(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...graph.nodeIds].some(walk);
}

function hasPathAvoiding(graph: Graph, from: string, target: string, forbidden: ReadonlySet<string>): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node !== from && forbidden.has(node)) continue;
    if (node === target) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of graph.outgoing.get(node) ?? []) pending.push(next);
  }
  return false;
}

function findNodes(definition: WorkflowDefinition, predicate: (node: WorkflowDefinition["nodes"][number]) => boolean): string[] {
  return definition.nodes.filter(predicate).map((node) => node.id);
}

function validateWorkflowDefinitionV2(definition: WorkflowDefinitionV2, registry: WorkflowRegistry): WorkflowValidationResult {
  const issues: WorkflowValidationFailure[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  const nodeIds = definition.nodes.map((node) => node.id);
  const uniqueNodeIds = new Set(nodeIds);
  if (uniqueNodeIds.size !== nodeIds.length) add("duplicate-node", "Workflow node IDs must be unique");
  if (!uniqueNodeIds.has(definition.entry)) add("entry", "Workflow entry must name a node");

  for (const node of definition.nodes) {
    if (!(node.uiGroup in registry.uiGroups)) add("ui-group", `Unregistered UI group: ${node.uiGroup}`);
    if (node.kind === "agent") {
      const registered = registry.agents[node.agent];
      if (!registered) add("agent", `Unregistered agent: ${node.agent}`);
      if (node.inputSchema && !(node.inputSchema in registry.outputSchemas)) add("input-schema", `Unregistered input schema: ${node.inputSchema}`);
      if (!(node.outputSchema in registry.outputSchemas)) add("output-schema", `Unregistered output schema: ${node.outputSchema}`);
      if (registered && !registered.capabilities.every((capability) => ["memory-read", "work-read", "proposal-read"].includes(capability))) {
        add("agent-capability", `Agent ${node.agent} has an unsafe capability`);
      }
    }
    if (node.kind === "tool") {
      if (!(node.handler in registry.tools)) add("tool", `Unregistered tool: ${node.handler}`);
      if (node.inputSchema && !(node.inputSchema in registry.outputSchemas)) add("input-schema", `Unregistered input schema: ${node.inputSchema}`);
      if (node.outputSchema && !(node.outputSchema in registry.outputSchemas)) add("output-schema", `Unregistered output schema: ${node.outputSchema}`);
    }
    if (node.kind === "approval" && !(node.approval in registry.approvals)) add("approval", `Unregistered approval: ${node.approval}`);
  }
  for (const edge of definition.edges) {
    if (!uniqueNodeIds.has(edge.from) || !uniqueNodeIds.has(edge.to)) add("edge-node", "Workflow edge references an unknown node");
    if (!(edge.when in registry.conditions)) add("condition", `Unregistered condition: ${edge.when}`);
  }
  const edgePairs = new Set<string>();
  for (const edge of definition.edges) {
    const pair = `${edge.from}\u0000${edge.to}`;
    if (edgePairs.has(pair)) add("duplicate-edge", "Workflow nodes may have at most one edge between them");
    edgePairs.add(pair);
  }

  const stageIds = definition.reviewStages.map((stage) => stage.id);
  if (new Set(stageIds).size !== stageIds.length) add("duplicate-review-stage", "Review stage IDs must be unique");
  for (const stage of definition.reviewStages) {
    const reviewer = registry.agents[stage.reviewer];
    const reviser = registry.agents[stage.reviser];
    if (!reviewer || reviewer.role !== "reviewer") add("review-stage-reviewer", `Review stage ${stage.id} requires a registered reviewer`);
    if (!reviser || reviser.role !== "writer" || !reviser.hostCapabilities.includes("chapter-body-commit")) {
      add("review-stage-reviser", `Review stage ${stage.id} requires a host-committing writer`);
    }
    for (const suffix of ["review", "gate", "revise"]) {
      if (uniqueNodeIds.has(`${stage.id}-${suffix}`)) add("review-stage-node-collision", `Review stage ${stage.id} collides with a main-chain node`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const graph = graphFor(definition);
  const reachable = visit(definition.entry, graph.outgoing);
  if (reachable.size !== graph.nodeIds.size) add("reachability", "Every workflow node must be reachable from entry");
  const terminals = [...graph.nodeIds].filter((id) => (graph.outgoing.get(id) ?? []).length === 0);
  if (terminals.length === 0) add("terminal", "Workflow must have a terminal node");
  const canReachTerminal = new Set<string>();
  for (const terminal of terminals) for (const id of visit(terminal, graph.incoming)) canReachTerminal.add(id);
  if (canReachTerminal.size !== graph.nodeIds.size) add("terminal-path", "Every workflow node must reach a terminal node");
  if (hasCycle(graph, () => false)) add("unbounded-cycle", "V2 main-chain JSON cannot contain cycles; review loops are compiler-owned");

  const nodesFor = (predicate: (node: WorkflowDefinitionV2["nodes"][number]) => boolean) => definition.nodes.filter(predicate).map((node) => node.id);
  const lockNodes = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.lockChapterTarget");
  const initializers = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.initializeWorkflowChapter");
  const memoryNodes = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.queryMemory");
  const proposals = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.createChapterProposal");
  const approvals = nodesFor((node) => node.kind === "approval" && node.approval === "chapter-proposal");
  const applies = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.applyChapterProposal");
  const verifies = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.verifyAppliedChapter");
  const extractors = nodesFor((node) => node.kind === "agent"
    && registry.agents[node.agent]?.role === "memory-extractor"
    && node.outputSchema === "chapter-memory.v2");
  const saves = nodesFor((node) => node.kind === "tool" && node.handler === "jizuo.saveChapterMemory");
  const write = definition.nodes.find((node) => node.id === "write");
  if (lockNodes.length !== 1 || initializers.length !== 1 || memoryNodes.length !== 1) add("required-nodes", "V2 requires exactly one target lock, chapter initializer, and memory query");
  if (proposals.length !== 0 || approvals.length !== 0 || applies.length !== 0 || verifies.length !== 1 || extractors.length !== 1 || saves.length !== 1) {
    add("required-nodes", "The serial workflow forbids proposal gates and requires verify, typed memory extraction, and memory save exactly once");
  }
  const candidateSchema = registry.outputSchemas[write?.kind === "agent" ? write.outputSchema : ""];
  if (write?.kind !== "agent" || registry.agents[write.agent]?.role !== "writer" || write.outputSchema !== "chapter-candidate.v1"
    || candidateSchema?.candidateHashField !== "candidateHash" || candidateSchema.candidateHashContract !== "candidate-hash.v1") {
    add("writer", "V2 write must use a registered writer and candidate hash schema");
  }

  const writeOutgoing = definition.edges.filter((edge) => edge.from === "write");
  if (writeOutgoing.length !== 1 || writeOutgoing[0]?.to !== "verify" || writeOutgoing[0]?.when !== "always") {
    add("review-stage-placement", "Serial review stages must occupy the canonical write-to-verify boundary");
  }

  const dominates = uniqueNodeIds.has(definition.entry) ? dominators(graph, definition.entry) : new Map<string, Set<string>>();
  const agentNodes = nodesFor((node) => node.kind === "agent");
  for (const anchor of [lockNodes[0], initializers[0], memoryNodes[0]]) {
    if (!anchor) continue;
    for (const agentNode of agentNodes) if (!dominates.get(agentNode)?.has(anchor)) add("review-stage-placement", "Target lock, initialization, and memory query must precede every agent");
  }
  if (verifies[0] && saves[0] && !dominates.get(saves[0])?.has(verifies[0])) add("save-memory", "Memory save must follow verification");
  if (extractors[0] && saves[0] && !dominates.get(saves[0])?.has(extractors[0])) add("save-memory", "Memory save must follow typed extraction");

  return issues.length === 0 ? { ok: true, definition } : { ok: false, issues };
}

export function validateWorkflowDefinition(input: unknown, registry: WorkflowRegistry): WorkflowValidationResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: [{ code: "schema", message: "Workflow definition violates the closed JSON schema" }] };
  }
  const definition = parsed.data;
  if (definition.schemaVersion === 2) return validateWorkflowDefinitionV2(definition, registry);
  const issues: WorkflowValidationFailure[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  const nodeIds = definition.nodes.map((node) => node.id);
  const uniqueNodeIds = new Set(nodeIds);
  if (uniqueNodeIds.size !== nodeIds.length) add("duplicate-node", "Workflow node IDs must be unique");
  if (!uniqueNodeIds.has(definition.entry)) add("entry", "Workflow entry must name a node");
  for (const node of definition.nodes) {
    if (!(node.uiGroup in registry.uiGroups)) add("ui-group", `Unregistered UI group: ${node.uiGroup}`);
    if (node.kind === "agent") {
      if (!(node.agent in registry.agents)) add("agent", `Unregistered agent: ${node.agent}`);
      if (node.inputSchema && !(node.inputSchema in registry.outputSchemas)) add("input-schema", `Unregistered input schema: ${node.inputSchema}`);
      if (!(node.outputSchema in registry.outputSchemas)) add("output-schema", `Unregistered output schema: ${node.outputSchema}`);
      const capabilities = registry.agents[node.agent]?.capabilities ?? [];
      if (!capabilities.every((capability) => ["memory-read", "work-read", "proposal-read"].includes(capability))) {
        add("agent-capability", `Agent ${node.agent} has an unsafe capability`);
      }
    }
    if (node.kind === "tool") {
      if (!(node.handler in registry.tools)) add("tool", `Unregistered tool: ${node.handler}`);
      if (node.inputSchema && !(node.inputSchema in registry.outputSchemas)) add("input-schema", `Unregistered input schema: ${node.inputSchema}`);
      if (node.outputSchema && !(node.outputSchema in registry.outputSchemas)) add("output-schema", `Unregistered output schema: ${node.outputSchema}`);
    }
    if (node.kind === "approval" && !(node.approval in registry.approvals)) add("approval", `Unregistered approval: ${node.approval}`);
  }
  for (const edge of definition.edges) {
    if (!uniqueNodeIds.has(edge.from) || !uniqueNodeIds.has(edge.to)) add("edge-node", "Workflow edge references an unknown node");
    if (!(edge.when in registry.conditions)) add("condition", `Unregistered condition: ${edge.when}`);
  }
  const edgePairs = new Set<string>();
  for (const edge of definition.edges) {
    const pair = `${edge.from}\u0000${edge.to}`;
    if (edgePairs.has(pair)) add("duplicate-edge", "Workflow nodes may have at most one edge between them");
    edgePairs.add(pair);
  }
  if (issues.length > 0) return { ok: false, issues };

  const graph = graphFor(definition);
  const usesDirectConditions = definition.edges.some((edge) => edge.when === "approvedCreateTarget" || edge.when === "approvedModifyTarget");
  const directStructure = supportsDirectChapterWrite(definition);
  const reachable = visit(definition.entry, graph.outgoing);
  if (reachable.size !== graph.nodeIds.size) add("reachability", "Every workflow node must be reachable from entry");
  const terminals = [...graph.nodeIds].filter((id) => (graph.outgoing.get(id) ?? []).length === 0);
  if (terminals.length === 0) add("terminal", "Workflow must have a terminal node");
  const canReachTerminal = new Set<string>();
  for (const terminal of terminals) for (const id of visit(terminal, graph.incoming)) canReachTerminal.add(id);
  if (canReachTerminal.size !== graph.nodeIds.size) add("terminal-path", "Every workflow node must reach a terminal node");

  for (const component of stronglyConnectedComponents(graph)) {
    const cyclic = component.length > 1 || (graph.outgoing.get(component[0]!) ?? []).includes(component[0]!);
    if (!cyclic) continue;
    const componentNodes = new Set(component);
    const boundedByRevision = definition.edges.some((edge) => edge.when === "revisionAllowed" && componentNodes.has(edge.from) && componentNodes.has(edge.to));
    const requiredLoopNodes = ["revise", "continuity", "style", "ai-trace", "review-gate"];
    if (!boundedByRevision || requiredLoopNodes.some((id) => !componentNodes.has(id))) {
      add("unbounded-cycle", "Only the bounded revision cycle may be cyclic");
    }
    if (definition.edges.some((edge) => componentNodes.has(edge.from) && edge.from === edge.to)) {
      add("unbounded-cycle", "The bounded revision cycle must not contain self-loops");
    }
  }
  const revisionCondition = registry.conditions.revisionAllowed;
  const revisionBinding = revisionCondition?.budget;
  if (definition.edges.some((edge) => edge.when === "revisionAllowed") && (
    revisionBinding?.budgetKey !== "maxRevisionRounds"
    || revisionBinding.counterKey !== "remainingRevisionRounds"
    || revisionBinding.decrementBy !== 1
    || revisionBinding.hardMaximum !== definition.budgets.hardMaxRevisionRounds
    || typeof revisionCondition?.implementation.consume !== "function"
  )) {
    add("revision-budget", "revisionAllowed must have a finite registered budget decrement contract");
  }
  if (hasCycle(graph, (from, to) => definition.edges.some((edge) => edge.from === from && edge.to === to && edge.when === "revisionAllowed"))) {
    add("unbounded-cycle", "Every cycle must consume the bounded revision condition");
  }

  const dominates = dominators(graph, definition.entry);
  const requireDominated = (nodes: string[], dominator: string, code: string, message: string) => {
    for (const node of nodes) if (!dominates.get(node)?.has(dominator)) add(code, message);
  };
  const lockNodes = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.lockChapterTarget");
  const memoryNodes = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.queryMemory");
  if (lockNodes.length !== 1 || memoryNodes.length !== 1) add("required-nodes", "Target lock and memory query must each be registered exactly once");
  const agents = findNodes(definition, (node) => node.kind === "agent");
  const initializers = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.initializeWorkflowChapter");
  // The canonical workflow always initializes create targets before any model;
  // custom graphs opt into the same contract by declaring the initializer.
  if (definition.id === "chapter-production" || initializers.length > 0) {
    if (initializers.length !== 1 || initializers[0] !== "initialize-chapter") {
      add("chapter-initialization", "New definitions require exactly one initialize-chapter tool");
    }
    if (initializers[0]) {
      requireDominated(agents, initializers[0], "chapter-initialization", "Chapter initialization must precede every agent");
      if (lockNodes[0]) requireDominated(initializers, lockNodes[0], "chapter-initialization", "A persisted target lock must precede initialization");
    }
  }
  if (lockNodes[0]) requireDominated(agents, lockNodes[0], "target-lock", "Target lock must precede every agent");
  if (memoryNodes[0]) requireDominated(agents, memoryNodes[0], "memory-query", "Memory query must precede every agent");

  const candidateHashSchema = (schemaId: string | undefined) => {
    const schema = schemaId ? registry.outputSchemas[schemaId] : undefined;
    return schema?.candidateHashField === "candidateHash" && schema.candidateHashContract === "candidate-hash.v1";
  };
  for (const writerId of ["write", "revise"]) {
    const writer = definition.nodes.find((node) => node.id === writerId);
    if (writer?.kind !== "agent" || registry.agents[writer.agent]?.role !== "writer" || writer.outputSchema !== "chapter-candidate.v1" || !candidateHashSchema(writer.outputSchema)) {
      add("writer", `${writerId} must use a registered writer and candidate hash schema`);
    }
  }

  const reviews = ["continuity", "style", "ai-trace"] as const;
  for (const review of reviews) {
    const node = definition.nodes.find((candidate) => candidate.id === review);
    if (node?.kind !== "agent" || node.agent !== `${review}-reviewer` || registry.agents[node.agent]?.role !== "reviewer" || node.inputSchema !== "chapter-candidate.v1" || node.outputSchema !== "chapter-review.v1" || node.candidateHashContract !== "candidate-hash.v1" || !candidateHashSchema(node.inputSchema) || !candidateHashSchema(node.outputSchema)) {
      add("review", `Required ${review} review is not registered`);
    }
  }
  const reviewGates = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.aggregateReviews");
  const proposals = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.createChapterProposal");
  if (reviewGates.length !== 1 || proposals.length !== 1) add("review-gate", "Exactly one registered review gate and proposal node are required");
  if (reviewGates[0]) {
    const gate = definition.nodes.find((node) => node.id === reviewGates[0]);
    const registeredGate = registry.tools["jizuo.aggregateReviews"];
    const branchConditionsRegistered = usesDirectConditions
      ? registry.conditions.approvedCreateTarget?.reviewGateHandler === "jizuo.aggregateReviews"
        && registry.conditions.approvedModifyTarget?.reviewGateHandler === "jizuo.aggregateReviews"
      : registry.conditions.allRequiredReviewsPass?.reviewGateHandler === "jizuo.aggregateReviews";
    if (registeredGate?.semantic !== "candidate-hash-review-gate" || registeredGate.candidateHashContract !== "candidate-hash.v1" || registeredGate.reviewGate?.requiredReviewKinds.length !== reviews.length || reviews.some((review) => !registeredGate.reviewGate?.requiredReviewKinds.includes(review)) || !branchConditionsRegistered || gate?.kind !== "tool" || gate.inputSchema !== "chapter-review.v1" || gate.outputSchema !== "chapter-approved-candidate.v1" || gate.candidateHashContract !== "candidate-hash.v1" || !candidateHashSchema(gate.inputSchema) || !candidateHashSchema(gate.outputSchema)) {
      add("review-gate", "The registered review gate must compare candidateHash");
    }
    const write = definition.nodes.find((node) => node.id === "write");
    for (const review of reviews) {
      if (!write || !visit(write.id, graph.outgoing).has(review) || !visit(review, graph.outgoing).has(reviewGates[0])) {
        add("review-gate", "All required reviews must feed the same candidateHash gate");
      }
    }
    requireDominated(proposals, reviewGates[0], "proposal", "Proposal must follow the registered candidateHash review gate");
  }
  for (const proposalId of proposals) {
    const proposal = definition.nodes.find((node) => node.id === proposalId);
    if (proposal?.kind !== "tool" || proposal.inputSchema !== "chapter-approved-candidate.v1" || proposal.candidateHashContract !== "candidate-hash.v1" || registry.tools[proposal.handler]?.candidateHashContract !== "candidate-hash.v1" || !candidateHashSchema(proposal.inputSchema)) {
      add("proposal", "Proposal must consume the same candidateHash contract from the review gate");
    }
  }

  const approvals = findNodes(definition, (node) => node.kind === "approval" && node.approval === "chapter-proposal");
  const applies = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.applyChapterProposal");
  const verifies = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.verifyAppliedChapter");
  const extractors = findNodes(definition, (node) => node.kind === "agent" && node.agent === "memory-extractor" && node.outputSchema === "chapter-memory.v1");
  const saves = findNodes(definition, (node) => node.kind === "tool" && node.handler === "jizuo.saveChapterMemory");
  if (approvals.length !== 1 || applies.length !== 1 || verifies.length !== 1 || extractors.length !== 1 || saves.length !== 1) {
    add("required-nodes", "Approval, apply, verify, memory extraction, and save-memory nodes must each be registered exactly once");
  }
  if (applies[0] && approvals[0]) requireDominated([applies[0]], approvals[0], "approval", "Every apply path must include a separate approval node");
  if (applies[0] && verifies[0]) {
    for (const terminal of terminals) {
      if (hasPathAvoiding(graph, applies[0], terminal, new Set([verifies[0]]))) {
        add("verify", "Every apply path must include verification");
      }
    }
  }
  if (saves[0]) {
    if (!usesDirectConditions && applies[0]) requireDominated([saves[0]], applies[0], "save-memory", "Memory save must follow apply");
    if (verifies[0]) requireDominated([saves[0]], verifies[0], "save-memory", "Memory save must follow verification");
    if (extractors[0]) requireDominated([saves[0]], extractors[0], "save-memory", "Memory save must follow registered extraction");
  }
  if (usesDirectConditions) {
    if (!directStructure) add("direct-branch", "Direct workflows require exactly one safe create and modify review branch");
    const gateId = reviewGates[0];
    const proposalId = proposals[0];
    const approvalId = approvals[0];
    const applyId = applies[0];
    const verifyId = verifies[0];
    if (gateId) {
      const createGraph = graphFor(definition, (edge) => edge.when !== "approvedModifyTarget");
      const modifyGraph = graphFor(definition, (edge) => edge.when !== "approvedCreateTarget");
      const createReachable = visit(gateId, createGraph.outgoing);
      if (proposalId && createReachable.has(proposalId)) add("create-proposal", "A direct create branch must never enter proposal");
      if (approvalId && createReachable.has(approvalId)) add("create-proposal", "A direct create branch must never enter approval");
      if (applyId && createReachable.has(applyId)) add("create-proposal", "A direct create branch must never enter apply");
      if (verifyId) {
        const createTerminals = [...createReachable].filter((id) => (createGraph.outgoing.get(id) ?? []).length === 0);
        if (!createReachable.has(verifyId) || createTerminals.some((terminal) => hasPathAvoiding(createGraph, gateId, terminal, new Set([verifyId])))) {
          add("create-verify", "Every direct create path must include final verification");
        }
      }
      if (applyId && approvalId) {
        const modifyReachable = visit(gateId, modifyGraph.outgoing);
        if (!modifyReachable.has(applyId) || hasPathAvoiding(modifyGraph, gateId, applyId, new Set([approvalId]))) {
          add("modify-approval", "Every modify apply path must include proposal approval");
        }
      }
    }
  }
  return issues.length === 0 ? { ok: true, definition } : { ok: false, issues };
}
