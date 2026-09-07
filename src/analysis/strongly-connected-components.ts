export interface StronglyConnectedComponentResult<Node> {
  /**
   * Components in reverse topological order: dependency sinks are emitted
   * before the components that depend on them.
   */
  components: Node[][];
  /** Component index for every node encountered as a key or dependency target. */
  componentOf: Map<Node, number>;
}

/**
 * Condense a directed graph into mutually reachable components.
 *
 * This is iterative Tarjan rather than recursive Tarjan so a large, deep
 * repository graph cannot overflow the JavaScript call stack.
 */
export function stronglyConnectedComponents<Node>(
  graph: ReadonlyMap<Node, ReadonlySet<Node>>,
): StronglyConnectedComponentResult<Node> {
  const componentOf = new Map<Node, number>();
  const components: Node[][] = [];
  const indices = new Map<Node, number>();
  const lowlink = new Map<Node, number>();
  const onStack = new Set<Node>();
  const stack: Node[] = [];
  let nextIndex = 0;

  type Frame = { node: Node; iter: Iterator<Node>; pendingChild: Node | null };
  const neighborsOf = (node: Node): Iterator<Node> => (graph.get(node) ?? []).values();

  function enterNode(node: Node, callStack: Frame[]): void {
    indices.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    callStack.push({ node, iter: neighborsOf(node), pendingChild: null });
  }

  function emitComponent(root: Node): void {
    if (lowlink.get(root) !== indices.get(root)) return;
    const component: Node[] = [];
    while (true) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      componentOf.set(member, components.length);
      if (member === root) break;
    }
    components.push(component);
  }

  function advanceFrame(callStack: Frame[]): void {
    const frame = callStack[callStack.length - 1]!;
    if (frame.pendingChild !== null) {
      const child = frame.pendingChild;
      frame.pendingChild = null;
      lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, lowlink.get(child)!));
    }
    const next = frame.iter.next();
    if (next.done) {
      emitComponent(frame.node);
      callStack.pop();
      return;
    }
    const child = next.value;
    if (!indices.has(child)) {
      frame.pendingChild = child;
      enterNode(child, callStack);
    } else if (onStack.has(child)) {
      lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indices.get(child)!));
    }
  }

  for (const start of graph.keys()) {
    if (indices.has(start)) continue;
    const callStack: Frame[] = [];
    enterNode(start, callStack);
    while (callStack.length > 0) advanceFrame(callStack);
  }

  return { components, componentOf };
}
