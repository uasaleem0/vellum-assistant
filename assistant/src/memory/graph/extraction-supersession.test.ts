import { describe, expect, test } from "bun:test";

import {
  type DeferredEdge,
  inheritSupersessionDurability,
} from "./extraction.js";
import type { MemoryDiff, MemoryNode } from "./types.js";

function node(overrides: Partial<MemoryNode>): MemoryNode {
  return {
    id: "node",
    content: "content",
    type: "semantic",
    created: 1,
    lastAccessed: 1,
    lastConsolidated: 0,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      originalIntensity: 0,
      decayCurve: "linear",
      decayRate: 0,
    },
    fidelity: "vivid",
    confidence: 0.8,
    significance: 0.1,
    stability: 1,
    reinforcementCount: 0,
    lastReinforced: 0,
    sourceConversations: [],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
    eventDate: null,
    ...overrides,
  };
}

function emptyDiff(): MemoryDiff {
  return {
    createNodes: [],
    updateNodes: [],
    deleteNodeIds: [],
    createEdges: [],
    deleteEdgeIds: [],
    createTriggers: [],
    deleteTriggerIds: [],
    reinforceNodeIds: [],
  };
}

function newNode(overrides: Partial<MemoryNode> = {}) {
  const { id: _id, ...rest } = node({ id: "ignored", ...overrides });
  return rest;
}

describe("inheritSupersessionDurability", () => {
  test("adds existing-to-existing durability inheritance to the diff instead of mutating storage", () => {
    const oldNode = node({
      id: "old",
      stability: 20,
      reinforcementCount: 4,
      significance: 0.9,
      eventDate: 123,
    });
    const newNode = node({
      id: "new",
      stability: 3,
      reinforcementCount: 1,
      significance: 0.2,
    });
    const diff = emptyDiff();
    diff.createEdges.push({
      sourceNodeId: "new",
      targetNodeId: "old",
      relationship: "supersedes",
      weight: 1,
      created: 10,
    });

    inheritSupersessionDurability(diff, [], (id) =>
      id === "old" ? oldNode : id === "new" ? newNode : null,
    );

    expect(diff.updateNodes).toEqual([
      {
        id: "new",
        changes: {
          stability: 20,
          reinforcementCount: 4,
          significance: 0.9,
          eventDate: 123,
          imageRefs: null,
        },
      },
    ]);
  });

  test("inherits durability into new node specs for deferred new-to-existing supersession", () => {
    const oldNode = node({
      id: "old",
      stability: 15,
      reinforcementCount: 2,
      significance: 0.7,
      eventDate: 456,
    });
    const diff = emptyDiff();
    diff.createNodes.push(newNode({ stability: 5, significance: 0.4 }));
    const deferredEdges: DeferredEdge[] = [
      {
        source: { kind: "new", newNodeIndex: 0 },
        target: { kind: "existing", nodeId: "old" },
        relationship: "supersedes",
        weight: 1,
      },
    ];

    inheritSupersessionDurability(diff, deferredEdges, (id) =>
      id === "old" ? oldNode : null,
    );

    expect(diff.createNodes[0].stability).toBe(15);
    expect(diff.createNodes[0].reinforcementCount).toBe(2);
    expect(diff.createNodes[0].significance).toBe(0.7);
    expect(diff.createNodes[0].eventDate).toBe(456);
  });
});
