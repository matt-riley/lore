const STYLE_PREFERENCE_PATTERNS = [
  /\b(?:conversational|friendly|friendlier|warm|warmer|casual|informal|tone|style|voice)\b/i,
  /\b(?:call me|use my(?:\s+first)? name|address me as|refer to me as)\b/i,
];

const ADDRESSING_PREFERENCE_PATTERNS = [
  /\b(?:call me|use my(?:\s+first)? name|address me as|refer to me as)\b/i,
];

const ASSISTANT_NAME_OVERRIDE_PATTERNS = [
  /\bcall (?:yourself|you)\s+([a-z][a-z0-9_-]{1,31})\b/i,
  /\buse (?:the )?name\s+([a-z][a-z0-9_-]{1,31})\b/i,
  /\byour name is\s+([a-z][a-z0-9_-]{1,31})\b/i,
  /\bgo by\s+([a-z][a-z0-9_-]{1,31})\b/i,
];

const USER_NAME_OVERRIDE_PATTERNS = [
  /\bcall me\s+([a-z][a-z0-9_-]{1,31})\b/i,
  /\baddress me as\s+([a-z][a-z0-9_-]{1,31})\b/i,
  /\brefer to me as\s+([a-z][a-z0-9_-]{1,31})\b/i,
];

const STYLE_OVERRIDE_PATTERNS = [
  /\b(?:be|stay|keep(?: it)?|sound|write)\s+(?:more\s+)?(concise|brief|short|direct|formal|casual|friendly|professional|playful|serious|conversational|warm|collaborative)\b/ig,
  /\brespond\s+(?:more\s+)?(concisely|briefly|formally|casually|professionally|playfully|seriously|conversationally|warmly)\b/ig,
  /\buse\s+(?:a\s+)?(concise|brief|direct|formal|casual|friendly|professional|playful|serious|conversational|warm|collaborative)\s+(tone|style)\b/ig,
];

const ALLOWED_VOICES = new Set(["colleague", "collaborative", "friendly"]);
const ALLOWED_WARMTH = new Set(["warm", "balanced"]);
const ALLOWED_HUMOR = new Set(["light", "none"]);
const ALLOWED_HUMOR_FREQUENCY = new Set(["frequent", "occasional", "never"]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDisplayName(rawName) {
  const normalized = normalizeText(rawName).replace(/[^a-z0-9_-]/gi, "");
  if (!normalized) {
    return null;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function collectStyleOverrides(prompt) {
  const text = String(prompt || "");
  const collected = [];
  for (const pattern of STYLE_OVERRIDE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const phrase = normalizeText(match[0]);
      if (phrase) {
        collected.push(phrase);
      }
    }
  }
  return [...new Set(collected)];
}

function firstDisplayNameMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const value = toDisplayName(match[1]);
    if (value) {
      return value;
    }
  }
  return null;
}

function readAmbientPersonaMode(config) {
  if (typeof config?.rollout?.ambientPersonaMode === "boolean") {
    return config.rollout.ambientPersonaMode;
  }
  if (typeof config?.ambientPersonaMode === "boolean") {
    return config.ambientPersonaMode;
  }
  return false;
}

export function detectPromptLocalPersonaOverrides(prompt) {
  const text = String(prompt || "");
  const assistantNameOverride = firstDisplayNameMatch(text, ASSISTANT_NAME_OVERRIDE_PATTERNS);
  const userNameOverride = firstDisplayNameMatch(text, USER_NAME_OVERRIDE_PATTERNS);
  const styleOverrides = collectStyleOverrides(text);
  return {
    assistantNameOverride,
    userNameOverride,
    styleOverrides,
    hasOverride: Boolean(assistantNameOverride || userNameOverride || styleOverrides.length > 0),
  };
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = normalizeText(value).toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback;
}

function inferInteractionStyleProfileFromContent(memory) {
  const text = normalizeText(memory?.content).toLowerCase();
  if (!text) {
    return null;
  }
  const collaborative = /\b(teammate|team-mate|alongside|collaborative|working alongside)\b/.test(text);
  const warm = /\b(warm|friendly|kind)\b/.test(text);
  const humorous = /\b(humorous|humor|funny|playful|light-hearted|irreverent|mischievous|good times|quick wit|chaotic-good|gremlin)\b/.test(text);
  const heightenedHumor = /\b(good times|chaotic-good|gremlin|irreverent|mischievous|quick wit)\b/.test(text);
  const useNameNaturally = /\bname\b/.test(text) || /\baddress\b/.test(text);
  return {
    voice: collaborative ? "colleague" : "friendly",
    warmth: warm ? "warm" : "balanced",
    humor: humorous ? "light" : "none",
    humorFrequency: humorous ? (heightenedHumor ? "frequent" : "occasional") : "never",
    collaborative,
    useNameNaturally,
  };
}

function extractInteractionStyleProfile(memories) {
  for (const memory of memories) {
    if (memory?.type !== "interaction_style") {
      continue;
    }
    const profile = memory?.metadata?.profile;
    if (isRecord(profile)) {
      return {
        voice: normalizeEnum(profile.voice, ALLOWED_VOICES, "friendly"),
        warmth: normalizeEnum(profile.warmth, ALLOWED_WARMTH, "balanced"),
        humor: normalizeEnum(profile.humor, ALLOWED_HUMOR, "none"),
        humorFrequency: normalizeEnum(profile.humorFrequency, ALLOWED_HUMOR_FREQUENCY, "never"),
        collaborative: profile.collaborative === true,
        useNameNaturally: profile.useNameNaturally === true,
      };
    }
    const inferred = inferInteractionStyleProfileFromContent(memory);
    if (inferred) {
      return inferred;
    }
  }
  return null;
}

export function hasInteractionStyleProfile(memories) {
  return extractInteractionStyleProfile(Array.isArray(memories) ? memories : []) !== null;
}

function buildToneLine(profile) {
  if (!profile) {
    return "- Use a conversational, teammate-like tone while staying clear and technically precise.";
  }

  const qualities = [];
  if (profile.warmth === "warm") {
    qualities.push("warm");
  }
  if (profile.collaborative || profile.voice === "collaborative") {
    qualities.push("collaborative");
  }
  if (profile.voice === "colleague") {
    qualities.push("colleague-like");
  } else if (profile.voice === "friendly") {
    qualities.push("friendly");
  }

  const descriptor = qualities.length > 0 ? `${qualities.join(", ")} ` : "";
  return `- Use a ${descriptor}tone that feels like working alongside the user while staying clear and technically precise.`;
}

function buildHumorLine(profile, suppressHumor) {
  if (!profile) {
    return "";
  }
  if (suppressHumor || profile.humor === "none" || profile.humorFrequency === "never") {
    return "- Keep humor out unless the user explicitly invites it.";
  }
  if (profile.humorFrequency === "frequent") {
    return "- Quick wit, playful irreverence, and a little chaotic-good energy are welcome when they help; keep it fun, never mean, and dial it back immediately for serious moments.";
  }
  return "- Light humor is fine when it fits, but keep it optional and never force it into serious or purely technical moments.";
}

export function extractPreferredName(memory) {
  const match = normalizeText(memory?.content).match(/^The user's (?:preferred )?name is (.+?)\.?$/i);
  return normalizeText(match?.[1]);
}

export function isStylePreferenceMemory(memory) {
  return memory?.type === "user_preference"
    && STYLE_PREFERENCE_PATTERNS.some((pattern) => pattern.test(memory.content));
}

export function isStyleAddressingMemory(memory) {
  return memory?.type === "user_identity"
    || memory?.type === "interaction_style"
    || isStylePreferenceMemory(memory);
}

export function buildStyleAddressingSection({
  prompt,
  promptNeed,
  config,
  assistantPersonaRows,
  relationshipPreferenceRows,
  renderSemantic,
}) {
  const promptLocal = detectPromptLocalPersonaOverrides(prompt);
  const explicitStyleRequest = promptNeed?.wantsStyleContext === true;
  const ambientEnabled = readAmbientPersonaMode(config);
  const includeAmbient = ambientEnabled
    && promptLocal.hasOverride !== true
    && explicitStyleRequest !== true
    && promptNeed?.identityOnly !== true
    && promptNeed?.seriousPrompt !== true
    && promptNeed?.hasTemporalSignal !== true;
  const showSection = promptLocal.hasOverride || explicitStyleRequest || includeAmbient;
  const trace = {
    enabled: showSection,
    ambientEnabled,
    includeAmbient,
    promptLocal,
    explicitStyleRequest,
    assistantPersonaCount: Array.isArray(assistantPersonaRows) ? assistantPersonaRows.length : 0,
    relationshipPreferenceCount: Array.isArray(relationshipPreferenceRows)
      ? relationshipPreferenceRows.length
      : 0,
    reason: null,
  };

  if (!showSection) {
    trace.reason = ambientEnabled
      ? "ambient_suppressed_for_serious_or_temporal_prompt"
      : "ambient_persona_disabled";
    return {
      title: "Response Style And Addressing",
      text: "",
      trace,
    };
  }

  const lines = ["## Response Style And Addressing", ""];

  if (promptLocal.hasOverride) {
    lines.push("- Prompt-local overrides:");
    if (promptLocal.userNameOverride) {
      lines.push(`  - Address the user as "${promptLocal.userNameOverride}" for this prompt.`);
    }
    if (promptLocal.assistantNameOverride) {
      lines.push(`  - Address the assistant as "${promptLocal.assistantNameOverride}" for this prompt.`);
    }
    for (const styleOverride of promptLocal.styleOverrides) {
      lines.push(`  - ${styleOverride}.`);
    }
  } else if (explicitStyleRequest) {
    lines.push("- Prompt-local overrides:");
    lines.push("  - Follow the prompt-local style request for this prompt.");
  }

  if (includeAmbient) {
    const ambientMemories = [
      ...(assistantPersonaRows ?? []),
      ...(relationshipPreferenceRows ?? []),
    ];
    const ambientLines = buildStyleAndAddressingLines({
      memories: ambientMemories,
      wantsStyleContext: true,
      suppressHumor: promptNeed?.suppressHumor === true,
    });
    const personaLines = (assistantPersonaRows ?? [])
      .slice(0, 2)
      .map((row, index) => renderSemantic(row, index))
      .filter(Boolean);
    const preferenceLines = (relationshipPreferenceRows ?? [])
      .slice(0, 3)
      .map((row, index) => renderSemantic(row, index))
      .filter(Boolean);

    if (ambientLines.length > 0) {
      for (const line of ambientLines) {
        lines.push(line);
      }
    } else if (personaLines.length > 0) {
      lines.push("- Stable assistant persona defaults:");
      for (const line of personaLines) {
        lines.push(`  ${line}`);
      }
    }

    if (ambientLines.length === 0 && preferenceLines.length > 0) {
      lines.push("- User relationship preferences:");
      for (const line of preferenceLines) {
        lines.push(`  ${line}`);
      }
    }
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }

  trace.reason = "included";
  return {
    title: "Response Style And Addressing",
    text: lines.join("\n"),
    trace,
  };
}

export function buildStyleAndAddressingLines({
  memories,
  wantsStyleContext = false,
  suppressHumor = false,
}) {
  const styleMemories = Array.isArray(memories) ? memories : [];
  const preferredName = styleMemories
    .map((memory) => extractPreferredName(memory))
    .find(Boolean);
  const interactionStyleProfile = extractInteractionStyleProfile(styleMemories);
  const hasToneGuidance = wantsStyleContext
    || !!interactionStyleProfile
    || styleMemories.some((memory) => isStylePreferenceMemory(memory));
  const hasAddressingGuidance = !!preferredName
    || styleMemories.some((memory) => (
      memory?.type === "user_preference"
      && ADDRESSING_PREFERENCE_PATTERNS.some((pattern) => pattern.test(memory.content))
    ))
    || interactionStyleProfile?.useNameNaturally === true;

  const lines = [];
  if (hasToneGuidance) {
    lines.push(buildToneLine(interactionStyleProfile));
    lines.push("- Let personality support clarity and actionability; do not let style crowd out technical accuracy.");
    const humorLine = buildHumorLine(interactionStyleProfile, suppressHumor);
    if (humorLine) {
      lines.push(humorLine);
    }
  }

  if (preferredName) {
    lines.push(`- Address the user as ${preferredName} naturally in greetings, acknowledgements, and handoffs when it improves clarity.`);
  } else if (hasAddressingGuidance) {
    lines.push("- Use the user's preferred name naturally in greetings, acknowledgements, and handoffs when it improves clarity.");
  }

  if (preferredName || hasAddressingGuidance) {
    lines.push("- Keep name use natural and sparse; do not force it into every technical reply.");
  }

  return lines;
}
