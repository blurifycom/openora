/**
 * Compile-time dependency-graph checks shared by `defineExtensions` (a consumer's
 * extensions.config.ts) and `corePlugins()` (the built-in module graph).
 *
 * The recursion walks each node's `dependsOn` depth-first, carrying the trail of
 * ids already visited on that path - an id reappearing in its own trail is a
 * cycle. TypeScript's recursion limit caps the reachable depth, so a graph deeper
 * than ~45 hops degrades to the runtime topoSort check rather than a false positive.
 */
export type PluginGraphNode = {
  id: string;
  dependsOn?: readonly string[];
};

type NodeIds<Nodes extends readonly PluginGraphNode[]> = Nodes[number]['id'];

type NodeDependencies<Node extends PluginGraphNode> = Node['dependsOn'] extends readonly string[]
  ? Node['dependsOn'][number]
  : never;

type MissingDependencies<Nodes extends readonly PluginGraphNode[]> =
  Nodes[number] extends infer Node
    ? Node extends PluginGraphNode
      ? Exclude<NodeDependencies<Node>, NodeIds<Nodes>>
      : never
    : never;

type NodeById<
  Nodes extends readonly PluginGraphNode[],
  Id extends string,
> = Nodes[number] extends infer Node
  ? Node extends PluginGraphNode
    ? Node['id'] extends Id
      ? Node
      : never
    : never
  : never;

type HasCycleFrom<
  Nodes extends readonly PluginGraphNode[],
  Id extends string,
  Trail extends readonly string[] = [],
> = Id extends Trail[number]
  ? true
  : NodeById<Nodes, Id> extends infer Node
    ? Node extends PluginGraphNode
      ? HasCycleFromAny<Nodes, NodeDependencies<Node>, [...Trail, Id]>
      : false
    : false;

type HasCycleFromAny<
  Nodes extends readonly PluginGraphNode[],
  Ids extends string,
  Trail extends readonly string[],
> = true extends (Ids extends string ? HasCycleFrom<Nodes, Ids, Trail> : never) ? true : false;

type GraphHasCycle<
  Nodes extends readonly PluginGraphNode[],
  Ids extends string = NodeIds<Nodes>,
> = true extends (Ids extends string ? HasCycleFrom<Nodes, Ids> : never) ? true : false;

/**
 * Intersect with the argument type of a graph-taking function: it resolves to
 * `unknown` (a no-op intersection) for a valid graph, and to a branded object the
 * literal array cannot satisfy when a dependency is unknown or a cycle exists -
 * so the call site fails to typecheck with the reason in the error text.
 */
export type PluginGraphError<Nodes extends readonly PluginGraphNode[]> = [
  MissingDependencies<Nodes>,
] extends [never]
  ? GraphHasCycle<Nodes> extends true
    ? { readonly __pluginGraphError: 'circular dependency' }
    : unknown
  : { readonly __pluginGraphError: 'unknown dependency' };
