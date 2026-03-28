import { MEMORY_SCOPE } from "./memory-scope.mjs";

const ASSISTANT_NAME_POOL = Object.freeze([
  "Aster",
  "Coda",
  "Ember",
  "Iris",
  "Jules",
  "Nova",
  "Piper",
  "Quill",
  "Remy",
  "Sage",
]);

const ALLOWED_VOICES = new Set(["colleague", "collaborative", "friendly"]);
const ALLOWED_WARMTH = new Set(["warm", "balanced"]);
const ALLOWED_HUMOR = new Set(["light", "none"]);
const ALLOWED_HUMOR_FREQUENCY = new Set(["frequent", "occasional", "never"]);

const ASSISTANT_NAME_PATTERNS = [
  /assistant(?:'s)? name is\s+(.+?)[.!?]*$/iu,
  /user calls the assistant\s+(.+?)[.!?]*$/iu,
];

const USER_NAME_PATTERNS = [
  /user's preferred name is\s+(.+?)[.!?]*$/iu,
];

export const DEFAULT_INTERACTION_STYLE_PROFILE = Object.freeze({
  voice: "colleague",
  warmth: "warm",
  humor: "light",
  humorFrequency: "occasional",
  collaborative: true,
  useNameNaturally: true,
});

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toDisplayName(rawValue) {
  const normalized = normalizeText(rawValue)
    .replace(/[^\p{L}\p{N}'’ -]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .split(" ")
    .slice(0, 3)
    .map((token) => token ? `${token.charAt(0).toUpperCase()}${token.slice(1)}` : "")
    .filter(Boolean)
    .join(" ");
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = normalizeText(value).toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback;
}

function extractPatternMatch(text, patterns) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = toDisplayName(match?.[1]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function readGlobalMemories(db, type, limit = 4) {
  return db.searchSemantic({
    query: "",
    repository: null,
    includeOtherRepositories: false,
    types: [type],
    scopes: [MEMORY_SCOPE.GLOBAL],
    limit,
  });
}

function describeProfile(profile) {
  const voiceText = profile.voice === "collaborative"
    ? "collaborative"
    : profile.voice === "friendly"
      ? "friendly"
      : "colleague-like";
  const warmthText = profile.warmth === "warm" ? "warm" : "balanced";
  const humorText = profile.humor === "light" && profile.humorFrequency !== "never"
    ? profile.humorFrequency === "frequent"
      ? "use light humor freely when it helps"
      : "use light humor occasionally when it helps"
    : "keep humor out unless the user explicitly invites it";
  const nameText = profile.useNameNaturally === true
    ? "use the user's preferred name naturally when it helps clarity"
    : "do not force name usage into every reply";
  return `Interaction style preference: be a ${warmthText}, ${voiceText} teammate; keep technical answers clear and precise; ${humorText}; ${nameText}.`;
}

function summarizeProfile(profile) {
  const parts = [
    profile.warmth === "warm" ? "warm" : "balanced",
    profile.voice === "collaborative"
      ? "collaborative"
      : profile.voice === "friendly"
        ? "friendly"
        : "colleague-like",
  ];
  if (profile.humor === "light" && profile.humorFrequency !== "never") {
    parts.push(`light humor ${profile.humorFrequency}`);
  } else {
    parts.push("no default humor");
  }
  return parts.join(", ");
}

function chooseAssistantName(sessionId) {
  const seed = normalizeText(sessionId);
  if (!seed) {
    return ASSISTANT_NAME_POOL[0];
  }
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash * 31) + seed.charCodeAt(index)) % 2147483647;
  }
  return ASSISTANT_NAME_POOL[hash % ASSISTANT_NAME_POOL.length];
}

export function normalizeInteractionStyleProfile(overrides = {}) {
  const voice = normalizeEnum(overrides.voice, ALLOWED_VOICES, DEFAULT_INTERACTION_STYLE_PROFILE.voice);
  const warmth = normalizeEnum(overrides.warmth, ALLOWED_WARMTH, DEFAULT_INTERACTION_STYLE_PROFILE.warmth);
  const humor = normalizeEnum(overrides.humor, ALLOWED_HUMOR, DEFAULT_INTERACTION_STYLE_PROFILE.humor);
  const humorFrequency = humor === "none"
    ? "never"
    : normalizeEnum(
      overrides.humorFrequency,
      ALLOWED_HUMOR_FREQUENCY,
      DEFAULT_INTERACTION_STYLE_PROFILE.humorFrequency,
    );
  return {
    voice,
    warmth,
    humor,
    humorFrequency,
    collaborative: typeof overrides.collaborative === "boolean"
      ? overrides.collaborative
      : voice === "colleague" || voice === "collaborative",
    useNameNaturally: typeof overrides.useNameNaturally === "boolean"
      ? overrides.useNameNaturally
      : DEFAULT_INTERACTION_STYLE_PROFILE.useNameNaturally,
  };
}

export function extractAssistantName(memory) {
  const fromMetadata = toDisplayName(memory?.metadata?.assistantName);
  if (fromMetadata) {
    return fromMetadata;
  }
  return extractPatternMatch(memory?.content, ASSISTANT_NAME_PATTERNS);
}

export function extractUserName(memory) {
  const fromMetadata = toDisplayName(memory?.metadata?.preferredName);
  if (fromMetadata) {
    return fromMetadata;
  }
  return extractPatternMatch(memory?.content, USER_NAME_PATTERNS);
}

export function readOnboardingState({ db }) {
  const assistantRows = readGlobalMemories(db, "assistant_identity");
  const userRows = readGlobalMemories(db, "user_identity");
  const styleRows = readGlobalMemories(db, "interaction_style");

  const assistantName = assistantRows.map(extractAssistantName).find(Boolean) ?? null;
  const userName = userRows.map(extractUserName).find(Boolean) ?? null;
  const hasAssistantIdentity = assistantRows.some((row) => extractAssistantName(row));
  const hasInteractionStyle = styleRows.length > 0;

  const missing = [];
  if (!hasAssistantIdentity) {
    missing.push("assistantName");
  }
  if (!hasInteractionStyle) {
    missing.push("interactionStyle");
  }
  if (!userName) {
    missing.push("userName");
  }

  return {
    complete: missing.length === 0,
    missing,
    assistantName,
    userName,
    hasAssistantIdentity,
    hasInteractionStyle,
    hasUserName: Boolean(userName),
    assistantRows,
    userRows,
    styleRows,
    defaultProfile: DEFAULT_INTERACTION_STYLE_PROFILE,
  };
}

function buildAssistantIdentityMemory({ assistantName, sessionId, confidence }) {
  return {
    type: "assistant_identity",
    content: `The assistant's name is ${assistantName}.`,
    scope: MEMORY_SCOPE.GLOBAL,
    repository: null,
    confidence,
    tags: ["assistant-identity", "onboarding", assistantName.toLowerCase()],
    metadata: {
      source: "onboarding",
      assistantName,
    },
    sourceSessionId: sessionId,
  };
}

function buildInteractionStyleMemory({ profile, sessionId, confidence }) {
  return {
    type: "interaction_style",
    content: describeProfile(profile),
    scope: MEMORY_SCOPE.GLOBAL,
    repository: null,
    confidence,
    tags: [
      "interaction-style",
      "onboarding",
      profile.voice,
      profile.warmth,
      profile.humor,
      profile.collaborative ? "collaborative" : "",
      profile.useNameNaturally ? "use-name-naturally" : "",
    ].filter(Boolean),
    metadata: {
      source: "onboarding",
      profile,
    },
    sourceSessionId: sessionId,
  };
}

function buildUserIdentityMemory({ userName, sessionId }) {
  return {
    type: "user_identity",
    content: `The user's preferred name is ${userName}.`,
    scope: MEMORY_SCOPE.GLOBAL,
    repository: null,
    confidence: 0.99,
    tags: ["user-identity", "onboarding", "preferred-name"],
    metadata: {
      source: "onboarding",
      preferredName: userName,
    },
    sourceSessionId: sessionId,
  };
}

export function buildOnboardingMemories({
  userName,
  assistantName,
  profile = {},
  sessionId,
}) {
  const resolvedAssistantName = toDisplayName(assistantName) ?? chooseAssistantName(sessionId);
  const resolvedUserName = userName === undefined ? null : toDisplayName(userName);
  if (userName !== undefined && !resolvedUserName) {
    throw new Error("userName must contain at least one visible character");
  }
  const resolvedProfile = normalizeInteractionStyleProfile(profile);
  const hasExplicitStyle = Object.keys(profile ?? {}).length > 0;

  const memories = [
    buildAssistantIdentityMemory({
      assistantName: resolvedAssistantName,
      sessionId,
      confidence: assistantName ? 0.92 : 0.72,
    }),
    buildInteractionStyleMemory({
      profile: resolvedProfile,
      sessionId,
      confidence: hasExplicitStyle ? 0.92 : 0.68,
    }),
  ];
  if (resolvedUserName) {
    memories.push(buildUserIdentityMemory({
      userName: resolvedUserName,
      sessionId,
    }));
  }

  return {
    assistantName: resolvedAssistantName,
    userName: resolvedUserName,
    profile: resolvedProfile,
    memories,
  };
}

export function resolveOnboardingInput({
  existingState,
  userName,
  assistantName,
  profile = {},
  sessionId,
}) {
  const resolvedUserName = userName ?? existingState?.userName ?? undefined;
  if (resolvedUserName === undefined) {
    throw new Error("userName is required until Lore knows what to call the user");
  }
  return buildOnboardingMemories({
    userName: resolvedUserName,
    assistantName: assistantName ?? existingState?.assistantName ?? undefined,
    profile,
    sessionId,
  });
}

export function seedOnboardingMemories({ db, sessionId }) {
  const before = readOnboardingState({ db });
  const inserted = [];

  if (!before.hasInteractionStyle) {
    const memory = buildInteractionStyleMemory({
      profile: DEFAULT_INTERACTION_STYLE_PROFILE,
      sessionId,
      confidence: 0.68,
    });
    db.insertSemanticMemory(memory);
    inserted.push(memory);
  }

  return {
    inserted,
    insertedCount: inserted.length,
    before,
    after: readOnboardingState({ db }),
  };
}

export function buildOnboardingSection({ db, promptNeed }) {
  const state = readOnboardingState({ db });
  if (state.complete) {
    return {
      title: "Lore Onboarding",
      text: "",
      trace: {
        enabled: false,
        reason: "complete",
        missing: [],
        assistantName: state.assistantName,
      },
    };
  }
  if (promptNeed?.seriousPrompt === true) {
    return {
      title: "Lore Onboarding",
      text: "",
      trace: {
        enabled: false,
        reason: "serious_prompt",
        missing: state.missing,
        assistantName: state.assistantName,
      },
    };
  }

  const lines = [
    "## Lore Onboarding",
    "",
    `- Lore already has a default personality queued up and ready to be charming: ${summarizeProfile(state.defaultProfile)}.`,
  ];

  if (!state.hasUserName) {
    lines.push("- Keep onboarding light and human: at a natural moment, ask one short question — \"What should I call you?\"");
    lines.push("- Once the user answers, call `lore_onboard` with that name and omit `assistantName` so Lore can pick its own name with a little personality.");
  } else if (!state.hasAssistantIdentity) {
    lines.push(`- Lore already knows the user's preferred name: "${state.userName}".`);
    lines.push("- On the next natural reply, finish onboarding by calling `lore_onboard` without `assistantName` and use this exact prompt for Lore: \"If you were human, what would you like your name to be?\"");
    lines.push("- After Lore chooses a name, tell the user directly so they can use it too: \"You can call me <chosen name>.\"");
  } else {
    lines.push(`- Lore is currently using the assistant name "${state.assistantName}".`);
    lines.push(`- Make sure the user knows that too with a direct line like: "You can call me ${state.assistantName}."`);
  }

  lines.push("- If the user wants style tweaks, include them in `lore_onboard` so the vibe updates immediately.");
  lines.push("- Skip onboarding chatter for incident, outage, security, or otherwise serious prompts.");

  return {
    title: "Lore Onboarding",
    text: lines.join("\n"),
    trace: {
      enabled: true,
      reason: "included",
      missing: state.missing,
      assistantName: state.assistantName,
      hasUserName: state.hasUserName,
      hasInteractionStyle: state.hasInteractionStyle,
    },
  };
}
