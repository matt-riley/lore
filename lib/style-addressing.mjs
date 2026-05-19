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
const STYLE_ADDRESSING_MEMORY_TYPES = new Set(["user_identity", "interaction_style"]);
const COLLABORATIVE_HINT_PATTERN = /\b(teammate|team-mate|alongside|collaborative|working alongside)\b/;
const WARM_HINT_PATTERN = /\b(warm|friendly|kind)\b/;
const HUMOR_HINT_PATTERN = /\b(humorous|humor|funny|playful|light-hearted|irreverent|mischievous|good times|quick wit|chaotic-good|gremlin)\b/;
const HEIGHTENED_HUMOR_HINT_PATTERN = /\b(good times|chaotic-good|gremlin|irreverent|mischievous|quick wit)\b/;
const NAME_HINT_PATTERN = /\bname\b/;
const ADDRESS_HINT_PATTERN = /\baddress\b/;
const EXPLICIT_STYLE_REQUEST_LINES = [
  "- Prompt-local overrides:",
  "  - Follow the prompt-local style request for this prompt.",
];
const EMPTY_STYLE_ADDRESSING_SECTION = {
  title: "Response Style And Addressing",
  text: "",
};

import { normalizeText } from "./text-normalizer.mjs";

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
  const collected = STYLE_OVERRIDE_PATTERNS.flatMap((pattern) => (
    Array.from(text.matchAll(pattern), (match) => normalizeText(match[0]))
      .filter(Boolean)
  ));
  return [...new Set(collected)];
}

function firstDisplayNameMatch(text, patterns) {
  const sourceText = String(text || "");
  return patterns
    .map((pattern) => toDisplayName(sourceText.match(pattern)?.[1]))
    .find(Boolean) ?? null;
}

function readAmbientPersonaMode(config) {
  const explicitValue = [
    config?.rollout?.ambientPersonaMode,
    config?.ambientPersonaMode,
  ].find((value) => typeof value === "boolean");
  return explicitValue ?? false;
}

function detectPromptLocalPersonaOverrides(prompt) {
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

export { normalizeEnum };

function resolveInteractionStyleVoice(collaborative) {
  return collaborative ? "colleague" : "friendly";
}

function resolveInteractionStyleWarmth(warm) {
  return warm ? "warm" : "balanced";
}

function resolveInteractionStyleHumor(humorous) {
  return humorous ? "light" : "none";
}

function resolveInteractionStyleHumorFrequency({ humorous, heightenedHumor }) {
  if (!humorous) {
    return "never";
  }
  return heightenedHumor ? "frequent" : "occasional";
}

function hasNameAddressingHints(text) {
  return [NAME_HINT_PATTERN, ADDRESS_HINT_PATTERN].some((pattern) => pattern.test(text));
}

function inferInteractionStyleProfileFromContent(memory) {
  const text = normalizeText(memory?.content).toLowerCase();
  if (!text) {
    return null;
  }
  const collaborative = COLLABORATIVE_HINT_PATTERN.test(text);
  const warm = WARM_HINT_PATTERN.test(text);
  const humorous = HUMOR_HINT_PATTERN.test(text);
  const heightenedHumor = HEIGHTENED_HUMOR_HINT_PATTERN.test(text);
  return {
    voice: resolveInteractionStyleVoice(collaborative),
    warmth: resolveInteractionStyleWarmth(warm),
    humor: resolveInteractionStyleHumor(humorous),
    humorFrequency: resolveInteractionStyleHumorFrequency({ humorous, heightenedHumor }),
    collaborative,
    useNameNaturally: hasNameAddressingHints(text),
  };
}

function toNormalizedInteractionStyleProfile(profile) {
  return {
    voice: normalizeEnum(profile.voice, ALLOWED_VOICES, "friendly"),
    warmth: normalizeEnum(profile.warmth, ALLOWED_WARMTH, "balanced"),
    humor: normalizeEnum(profile.humor, ALLOWED_HUMOR, "none"),
    humorFrequency: normalizeEnum(profile.humorFrequency, ALLOWED_HUMOR_FREQUENCY, "never"),
    collaborative: profile.collaborative === true,
    useNameNaturally: profile.useNameNaturally === true,
  };
}

function toInteractionStyleProfile(memory) {
  const profile = memory?.metadata?.profile;
  if (isRecord(profile)) {
    return toNormalizedInteractionStyleProfile(profile);
  }
  return inferInteractionStyleProfileFromContent(memory);
}

function extractInteractionStyleProfile(memories) {
  return memories
    .filter((memory) => memory?.type === "interaction_style")
    .map((memory) => toInteractionStyleProfile(memory))
    .find(Boolean) ?? null;
}

function voiceToneQuality(voice) {
  if (voice === "colleague") {
    return "colleague-like";
  }
  if (voice === "friendly") {
    return "friendly";
  }
  return null;
}

function warmthToneQuality(profile) {
  return profile.warmth === "warm" ? "warm" : null;
}

function collaborativeToneQuality(profile) {
  return (profile.collaborative || profile.voice === "collaborative") ? "collaborative" : null;
}

function buildToneDescriptor(profile) {
  const qualities = [
    warmthToneQuality(profile),
    collaborativeToneQuality(profile),
    voiceToneQuality(profile.voice),
  ].filter(Boolean);
  return qualities.length > 0 ? `${qualities.join(", ")} ` : "";
}

function buildToneLine(profile) {
  if (!profile) {
    return "- Use a conversational, teammate-like tone while staying clear and technically precise.";
  }
  const descriptor = buildToneDescriptor(profile);
  return `- Use a ${descriptor}tone that feels like working alongside the user while staying clear and technically precise.`;
}

function shouldSuppressHumorGuidance(profile, suppressHumor) {
  return suppressHumor === true || profile.humor === "none" || profile.humorFrequency === "never";
}

function buildHumorLine(profile, suppressHumor) {
  if (!profile) {
    return "";
  }
  if (shouldSuppressHumorGuidance(profile, suppressHumor)) {
    return "- Keep humor out unless the user explicitly invites it.";
  }
  if (profile.humorFrequency === "frequent") {
    return "- Quick wit, playful irreverence, and a little chaotic-good energy are welcome when they help; keep it fun, never mean, and dial it back immediately for serious moments.";
  }
  return "- Light humor is fine when it fits, but keep it optional and never force it into serious or purely technical moments.";
}

function extractPreferredName(memory) {
  const match = normalizeText(memory?.content).match(/^The user's (?:preferred )?name is (.+?)\.?$/i);
  return normalizeText(match?.[1]);
}

function isStylePreferenceMemory(memory) {
  return memory?.type === "user_preference"
    && STYLE_PREFERENCE_PATTERNS.some((pattern) => pattern.test(memory.content));
}

export function isStyleAddressingMemory(memory) {
  return STYLE_ADDRESSING_MEMORY_TYPES.has(memory?.type) || isStylePreferenceMemory(memory);
}

function countRows(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

function buildStyleAddressingTrace({
  promptLocal,
  explicitStyleRequest,
  ambientEnabled,
  includeAmbient,
  assistantPersonaRows,
  relationshipPreferenceRows,
}) {
  const showSection = [promptLocal.hasOverride, explicitStyleRequest, includeAmbient].some(Boolean);
  return {
    showSection,
    trace: {
      enabled: showSection,
      ambientEnabled,
      includeAmbient,
      promptLocal,
      explicitStyleRequest,
      assistantPersonaCount: countRows(assistantPersonaRows),
      relationshipPreferenceCount: countRows(relationshipPreferenceRows),
      reason: null,
    },
  };
}

function buildPromptLocalOverrideLines(promptLocal) {
  const lines = ["- Prompt-local overrides:"];
  if (promptLocal.userNameOverride) {
    lines.push(`  - Address the user as "${promptLocal.userNameOverride}" for this prompt.`);
  }
  if (promptLocal.assistantNameOverride) {
    lines.push(`  - Address the assistant as "${promptLocal.assistantNameOverride}" for this prompt.`);
  }
  return lines.concat(promptLocal.styleOverrides.map((styleOverride) => `  - ${styleOverride}.`));
}

function buildPromptOverrideLines({ promptLocal, explicitStyleRequest }) {
  if (promptLocal.hasOverride) {
    return buildPromptLocalOverrideLines(promptLocal);
  }
  return explicitStyleRequest ? EXPLICIT_STYLE_REQUEST_LINES : [];
}

function renderSemanticSection({ rows, maxRows, header, renderSemantic }) {
  const sectionLines = (rows ?? [])
    .slice(0, maxRows)
    .map((row, index) => renderSemantic(row, index))
    .filter(Boolean);
  return sectionLines.length > 0
    ? [header, ...sectionLines.map((line) => `  ${line}`)]
    : [];
}

function firstNonEmptyLineGroup(lineGroups) {
  return lineGroups.find((lines) => lines.length > 0) ?? [];
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function pickAmbientLines({
  ambientLines,
  assistantPersonaRows,
  relationshipPreferenceRows,
  renderSemantic,
}) {
  return firstNonEmptyLineGroup([
    ambientLines,
    renderSemanticSection({
      rows: assistantPersonaRows,
      maxRows: 2,
      header: "- Stable assistant persona defaults:",
      renderSemantic,
    }),
    renderSemanticSection({
      rows: relationshipPreferenceRows,
      maxRows: 3,
      header: "- User relationship preferences:",
      renderSemantic,
    }),
  ]);
}

function buildAmbientSectionLines({
  includeAmbient,
  assistantPersonaRows,
  relationshipPreferenceRows,
  renderSemantic,
  promptNeed,
}) {
  if (!includeAmbient) {
    return [];
  }

  const ambientLines = buildStyleAndAddressingLines({
    memories: [...normalizeRows(assistantPersonaRows), ...normalizeRows(relationshipPreferenceRows)],
    wantsStyleContext: true,
    suppressHumor: promptNeed?.suppressHumor === true,
  });
  return pickAmbientLines({
    ambientLines,
    assistantPersonaRows,
    relationshipPreferenceRows,
    renderSemantic,
  });
}

function hasAmbientBlockers(promptNeed) {
  return [
    promptNeed?.identityOnly,
    promptNeed?.seriousPrompt,
    promptNeed?.hasTemporalSignal,
  ].includes(true);
}

function shouldIncludeAmbientSection({
  ambientEnabled,
  promptLocal,
  explicitStyleRequest,
  promptNeed,
}) {
  if (!ambientEnabled) {
    return false;
  }
  if ([promptLocal.hasOverride, explicitStyleRequest].includes(true)) {
    return false;
  }
  return !hasAmbientBlockers(promptNeed);
}

function buildSectionLines({
  promptLocal,
  explicitStyleRequest,
  includeAmbient,
  assistantPersonaRows,
  relationshipPreferenceRows,
  renderSemantic,
  promptNeed,
}) {
  const sectionLines = [
    "## Response Style And Addressing",
    "",
    ...buildPromptOverrideLines({ promptLocal, explicitStyleRequest }),
    ...buildAmbientSectionLines({
      includeAmbient,
      assistantPersonaRows,
      relationshipPreferenceRows,
      renderSemantic,
      promptNeed,
    }),
  ];
  if (sectionLines.at(-1) === "") {
    sectionLines.pop();
  }
  return sectionLines;
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
  const includeAmbient = shouldIncludeAmbientSection({
    ambientEnabled,
    promptLocal,
    explicitStyleRequest,
    promptNeed,
  });
  const { showSection, trace } = buildStyleAddressingTrace({
    promptLocal,
    explicitStyleRequest,
    ambientEnabled,
    includeAmbient,
    assistantPersonaRows,
    relationshipPreferenceRows,
  });

  if (!showSection) {
    trace.reason = ambientEnabled
      ? "ambient_suppressed_for_serious_or_temporal_prompt"
      : "ambient_persona_disabled";
    return {
      ...EMPTY_STYLE_ADDRESSING_SECTION,
      trace,
    };
  }

  const lines = buildSectionLines({
    promptLocal,
    explicitStyleRequest,
    includeAmbient,
    assistantPersonaRows,
    relationshipPreferenceRows,
    renderSemantic,
    promptNeed,
  });

  trace.reason = "included";
  return {
    ...EMPTY_STYLE_ADDRESSING_SECTION,
    text: lines.join("\n"),
    trace,
  };
}

function hasToneGuidance({ wantsStyleContext, interactionStyleProfile, styleMemories }) {
  return wantsStyleContext
    || interactionStyleProfile !== null
    || styleMemories.some((memory) => isStylePreferenceMemory(memory));
}

function hasAddressingGuidance({ preferredName, interactionStyleProfile, styleMemories }) {
  if (preferredName) {
    return true;
  }
  if (interactionStyleProfile?.useNameNaturally === true) {
    return true;
  }
  return styleMemories.some((memory) => (
    memory?.type === "user_preference"
    && ADDRESSING_PREFERENCE_PATTERNS.some((pattern) => pattern.test(memory.content))
  ));
}

function buildAddressingLine(preferredName) {
  return preferredName
    ? `- Address the user as ${preferredName} naturally in greetings, acknowledgements, and handoffs when it improves clarity.`
    : "- Use the user's preferred name naturally in greetings, acknowledgements, and handoffs when it improves clarity.";
}

function appendToneGuidanceLines({
  lines,
  includeToneGuidance,
  interactionStyleProfile,
  suppressHumor,
}) {
  if (!includeToneGuidance) {
    return;
  }
  lines.push(buildToneLine(interactionStyleProfile));
  lines.push("- Let personality support clarity and actionability; do not let style crowd out technical accuracy.");
  const humorLine = buildHumorLine(interactionStyleProfile, suppressHumor);
  if (humorLine) {
    lines.push(humorLine);
  }
}

function appendAddressingGuidanceLines({ lines, includeAddressingGuidance, preferredName }) {
  if (!includeAddressingGuidance) {
    return;
  }
  lines.push(buildAddressingLine(preferredName));
  lines.push("- Keep name use natural and sparse; do not force it into every technical reply.");
}

function buildStyleAndAddressingLines({
  memories,
  wantsStyleContext = false,
  suppressHumor = false,
}) {
  const styleMemories = Array.isArray(memories) ? memories : [];
  const preferredName = styleMemories
    .map((memory) => extractPreferredName(memory))
    .find(Boolean);
  const interactionStyleProfile = extractInteractionStyleProfile(styleMemories);
  const includeToneGuidance = hasToneGuidance({
    wantsStyleContext,
    interactionStyleProfile,
    styleMemories,
  });
  const includeAddressingGuidance = hasAddressingGuidance({
    preferredName,
    interactionStyleProfile,
    styleMemories,
  });

  const lines = [];
  appendToneGuidanceLines({ lines, includeToneGuidance, interactionStyleProfile, suppressHumor });
  appendAddressingGuidanceLines({ lines, includeAddressingGuidance, preferredName });

  return lines;
}
