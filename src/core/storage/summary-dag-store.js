const path = require("path");
const { JsonFileStore } = require("./json-file");

/**
 * DAG-based summary store for hierarchical conversation compaction.
 *
 * Nodes:
 *   - depth 0 (leaf): summarised from raw messages
 *   - depth 1+  : condensed from multiple child nodes
 *
 * Each node: { id, depth, summary, childIds, createdAt, tokenEstimate }
 */

const EMPTY_DAG = () => ({
  version: 1,
  nextId: 1,
  nodes: {},
  rootIds: [],   // ids with no parent (top-level summaries for context assembly)
  leafIds: [],   // depth-0 ids in chronological order
});

class SummaryDagStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "summary-dag.json"), EMPTY_DAG);
  }

  _dag() {
    return this.read();
  }

  /** Add a leaf node (depth 0) from raw message compaction */
  addLeaf(summary, tokenEstimate = 0) {
    const dag = this._dag();
    const id = dag.nextId++;
    dag.nodes[id] = {
      id,
      depth: 0,
      summary,
      childIds: [],
      createdAt: new Date().toISOString(),
      tokenEstimate,
    };
    dag.leafIds.push(id);
    dag.rootIds.push(id);
    this.write(dag);
    return id;
  }

  /** Condense multiple root nodes into a single higher-depth node */
  condense(childIds, summary, tokenEstimate = 0) {
    const dag = this._dag();
    const maxDepth = Math.max(...childIds.map((cid) => (dag.nodes[cid] ? dag.nodes[cid].depth : 0)));
    const id = dag.nextId++;
    dag.nodes[id] = {
      id,
      depth: maxDepth + 1,
      summary,
      childIds,
      createdAt: new Date().toISOString(),
      tokenEstimate,
    };
    // Remove children from rootIds, add new node
    dag.rootIds = dag.rootIds.filter((rid) => !childIds.includes(rid));
    dag.rootIds.push(id);
    this.write(dag);
    return id;
  }

  /** Get all root summaries (for context assembly) */
  getRootSummaries() {
    const dag = this._dag();
    return dag.rootIds
      .map((id) => dag.nodes[id])
      .filter(Boolean)
      .map((n) => n.summary);
  }

  /** Get count of uncondensed leaf nodes (roots at depth 0) */
  getUncondensedLeafCount() {
    const dag = this._dag();
    return dag.rootIds.filter((id) => dag.nodes[id] && dag.nodes[id].depth === 0).length;
  }

  /** Get uncondensed leaf root ids */
  getUncondensedLeafIds() {
    const dag = this._dag();
    return dag.rootIds.filter((id) => dag.nodes[id] && dag.nodes[id].depth === 0);
  }

  /** Get total estimated tokens across all root summaries */
  getRootTokenEstimate() {
    const dag = this._dag();
    return dag.rootIds.reduce((sum, id) => {
      const node = dag.nodes[id];
      return sum + (node ? node.tokenEstimate : 0);
    }, 0);
  }

  /** Check if store has any summaries */
  isEmpty() {
    const dag = this._dag();
    return dag.rootIds.length === 0;
  }

  /** Clear all DAG data */
  clear() {
    this.write(EMPTY_DAG());
  }
}

module.exports = { SummaryDagStore };
