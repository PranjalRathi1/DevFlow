/**
 * Deterministic dependency graph engine. Used both to validate AI-suggested
 * plans (temporary task identifiers as nodes) and real Task dependency
 * edges (ObjectId strings as nodes) — the algorithms don't care which.
 *
 * Direction convention (documented once, applies everywhere in this file
 * and everywhere it's consumed): an edge `{ from: "A", to: "B" }` means
 * "task A depends on task B" — B must be completed before A can become
 * ready. This matches `Task.dependencies` (an array of task ids a task
 * depends on) and the AI plan schema's `dependsOn` field.
 *
 * Not trusted to the AI or to client input: every caller that accepts
 * externally-suggested edges (AI output, a task update body) must run
 * them through `validateGraph` here before persisting anything.
 */

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface DependencyGraph {
  nodes: string[];
  edges: DependencyEdge[];
}

export type GraphValidationError =
  | { type: "self_dependency"; taskId: string }
  | { type: "duplicate_edge"; from: string; to: string }
  | { type: "missing_node"; taskId: string; referencedBy: string }
  | { type: "cycle"; cycle: string[] };

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
}

interface Adjacency {
  dependsOn: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
}

function buildAdjacency(graph: DependencyGraph): Adjacency {
  const dependsOn = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    dependsOn.set(node, new Set());
    dependents.set(node, new Set());
  }
  for (const edge of graph.edges) {
    // Only wire up edges between known nodes — validateGraph reports the
    // rest as missing_node errors; algorithms below assume a clean graph.
    if (!dependsOn.has(edge.from) || !dependsOn.has(edge.to)) continue;
    dependsOn.get(edge.from)?.add(edge.to);
    dependents.get(edge.to)?.add(edge.from);
  }
  return { dependsOn, dependents };
}

/**
 * Runs every structural check and returns *all* errors found (not just the
 * first), so a caller can surface a complete picture of what's wrong with
 * an AI-suggested or user-submitted graph in one response.
 */
export function validateGraph(graph: DependencyGraph): GraphValidationResult {
  const errors: GraphValidationError[] = [];
  const nodeSet = new Set(graph.nodes);
  const seenEdges = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.from === edge.to) {
      errors.push({ type: "self_dependency", taskId: edge.from });
      continue;
    }
    if (!nodeSet.has(edge.from)) {
      errors.push({ type: "missing_node", taskId: edge.from, referencedBy: edge.to });
    }
    if (!nodeSet.has(edge.to)) {
      errors.push({ type: "missing_node", taskId: edge.to, referencedBy: edge.from });
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) {
      errors.push({ type: "duplicate_edge", from: edge.from, to: edge.to });
    }
    seenEdges.add(key);
  }

  for (const cycle of detectCycles(graph)) {
    errors.push({ type: "cycle", cycle });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * DFS-based cycle detection (white/gray/black coloring). Returns each
 * distinct cycle found as the ordered list of node ids forming it (first
 * id repeated at the end). A graph with overlapping cycles may report more
 * than one entry touching the same nodes — acceptable here since callers
 * only need "is this graph acyclic," not a minimal cycle basis.
 */
function detectCycles(graph: DependencyGraph): string[][] {
  const { dependsOn } = buildAdjacency(graph);
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(node: string): void {
    color.set(node, 1);
    stack.push(node);
    for (const dep of [...(dependsOn.get(node) ?? [])].sort()) {
      const depColor = color.get(dep) ?? 0;
      if (depColor === 0) {
        visit(dep);
      } else if (depColor === 1) {
        const idx = stack.indexOf(dep);
        cycles.push([...stack.slice(idx), dep]);
      }
    }
    stack.pop();
    color.set(node, 2);
  }

  for (const node of [...graph.nodes].sort()) {
    if ((color.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}

/**
 * Kahn's algorithm. Ties (multiple nodes simultaneously ready) are broken
 * by sorted id, so the same graph always produces the same order —
 * required determinism for a plan review the user can trust.
 *
 * Returns `null` if the graph has a cycle (use `validateGraph` first for a
 * detailed error report — this just signals "can't be ordered").
 */
export function topologicalSort(graph: DependencyGraph): string[] | null {
  const { dependsOn, dependents } = buildAdjacency(graph);
  const remaining = new Map(graph.nodes.map((id) => [id, dependsOn.get(id)?.size ?? 0]));
  const queue = graph.nodes.filter((id) => remaining.get(id) === 0).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    queue.sort();
    const id = queue.shift() as string;
    order.push(id);
    for (const dependent of [...(dependents.get(id) ?? [])].sort()) {
      const next = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  return order.length === graph.nodes.length ? order : null;
}

export function getDependencies(graph: DependencyGraph, taskId: string): string[] {
  return [...(buildAdjacency(graph).dependsOn.get(taskId) ?? [])].sort();
}

export function getDependents(graph: DependencyGraph, taskId: string): string[] {
  return [...(buildAdjacency(graph).dependents.get(taskId) ?? [])].sort();
}

/** A not-yet-completed task is "ready" once every task it depends on is completed. */
export function getReadyTasks(graph: DependencyGraph, completed: Iterable<string>): string[] {
  const completedSet = new Set(completed);
  const { dependsOn } = buildAdjacency(graph);
  return graph.nodes
    .filter((id) => !completedSet.has(id))
    .filter((id) => [...(dependsOn.get(id) ?? [])].every((dep) => completedSet.has(dep)))
    .sort();
}

/** A not-yet-completed task is "blocked" if at least one of its dependencies isn't completed yet. */
export function getBlockedTasks(graph: DependencyGraph, completed: Iterable<string>): string[] {
  const completedSet = new Set(completed);
  const { dependsOn } = buildAdjacency(graph);
  return graph.nodes
    .filter((id) => !completedSet.has(id))
    .filter((id) => [...(dependsOn.get(id) ?? [])].some((dep) => !completedSet.has(dep)))
    .sort();
}
