// Illustrative state and retrieval examples for the documentation walkthrough.
// This is intentionally separate from Lore's runtime and has no database access.

const DEFAULT_DRAFT = "Use pnpm for package scripts.";
const DEMO_REPOSITORY = "demo/orchard";

export function createSession() {
  return { phase: "draft", draft: DEFAULT_DRAFT, memory: null, session: 1 };
}

export function transitionSession(state, action, payload = "") {
  if (action === "reset") return createSession();

  if (action === "edit" && state.phase === "draft" && typeof payload === "string") {
    return { ...state, draft: payload.trim().slice(0, 160) };
  }

  if (action === "save" && state.phase === "draft") {
    const content = state.draft.trim();
    if (!content) return state;
    return {
      ...state,
      phase: "saved",
      memory: {
        content,
        scope: "repo",
        repository: DEMO_REPOSITORY,
        type: "user_preference",
      },
    };
  }

  if (action === "next" && state.phase === "saved") {
    return { ...state, phase: "new-session", session: 2 };
  }

  if (action === "recall" && state.phase === "new-session") {
    return { ...state, phase: "recalled" };
  }

  return state;
}

export function scopeMemories(repository) {
  const memories = [
    {
      id: "global-preference",
      content: "Prefer concise answers.",
      scope: "global",
      repository: null,
      eligible: true,
      reason: "Global memories are eligible in every repository.",
    },
    {
      id: "orchard-sqlite",
      content: "The orchard project uses SQLite.",
      scope: "repo",
      repository: "demo/orchard",
      eligible: repository === "demo/orchard",
      reason: repository === "demo/orchard" ? "Repository matches." : "Repository scope does not match.",
    },
    {
      id: "orchard-pnpm",
      content: "The orchard project uses pnpm scripts.",
      scope: "repo",
      repository: "demo/orchard",
      eligible: repository === "demo/orchard",
      reason: repository === "demo/orchard" ? "Repository matches." : "Repository scope does not match.",
    },
    {
      id: "atlas-postgres",
      content: "The atlas project uses Postgres.",
      scope: "repo",
      repository: "demo/atlas",
      eligible: repository === "demo/atlas",
      reason: repository === "demo/atlas" ? "Repository matches." : "Repository scope does not match.",
    },
  ];
  return memories;
}

export function retrievalExample(mode) {
  const lexical = ["The database runs locally in SQLite."];
  if (mode === "semantic") {
    return {
      lexical,
      semantic: ["Keep project data on this machine; no hosted storage."],
      explanation: "Keyword matches are joined by an optional meaning-based match.",
    };
  }
  if (mode === "offline") {
    return {
      lexical,
      semantic: [],
      explanation: "Endpoint unavailable; the lexical result remains available.",
    };
  }
  return {
    lexical,
    semantic: [],
    explanation: "Keyword retrieval returns the direct lexical match.",
  };
}
