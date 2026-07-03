import { normalizeText } from "./text-normalizer.mjs";
import { estimateTokens } from "./token-estimator.mjs";

const MS_PER_HOUR = 60 * 60 * 1000;
const USER_DOMAIN_KIND = "user";
const DEFAULT_WORKING_PROFILE_BUDGET = 240;
const SECTION_TITLE = "Working Profile";

function truncateToBudget(text, budgetTokens) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  const maxChars = Math.max(0, Math.floor(budgetTokens) * 4);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

// Finds the freshest active "user" domain and its most recently refreshed,
// current-status observation. Freshness is computed live against
// freshness_hours rather than trusting the stored status column, since
// nothing in this codebase flips status to "stale" over time on its own.
function findActiveUserProfileObservation({ db }) {
  const domains = db
    .listMemoryDomains({ status: "active", includeOtherRepositories: true })
    .filter((domain) => domain.kind === USER_DOMAIN_KIND);
  if (domains.length === 0) {
    return { domain: null, observation: null, reason: "no_user_domain", ageHours: null };
  }

  const domain = domains[0];
  const observations = db.listObservations({
    domainKey: domain.domainKey,
    status: "current",
    includeOtherRepositories: true,
  });
  if (observations.length === 0) {
    return { domain, observation: null, reason: "no_observation", ageHours: null };
  }

  const observation = observations[0];
  const referenceIso = observation.lastRefreshedAt || observation.updatedAt;
  const ageMs = Date.now() - Date.parse(referenceIso);
  const ageHours = Number.isFinite(ageMs) ? Math.round((ageMs / MS_PER_HOUR) * 10) / 10 : null;
  if (ageHours === null || ageHours > observation.freshnessHours) {
    return { domain, observation, reason: "stale", ageHours };
  }

  return { domain, observation, reason: null, ageHours };
}

function buildDisabledSection(reason, extra = {}) {
  return {
    title: SECTION_TITLE,
    text: "",
    trace: {
      enabled: false,
      reason,
      ...extra,
    },
  };
}

// Ambient, session-start-only surfacing of the on-demand `matt-profile`-style
// working profile observation (see lore_reflect / persistObservation). Kept
// deliberately lightweight: only the condensed summary is shown, capped by
// config.budgets.workingProfile, and gated behind both a rollout flag and a
// live freshness check so a stale profile never silently pollutes context.
export function buildWorkingProfileSection({ db, config }) {
  if (!config?.rollout?.ambientWorkingProfile) {
    return buildDisabledSection("rollout_disabled");
  }
  if (!db) {
    return buildDisabledSection("no_db");
  }

  const lookup = findActiveUserProfileObservation({ db });
  if (!lookup.observation) {
    return buildDisabledSection(lookup.reason, {
      domainKey: lookup.domain?.domainKey ?? null,
    });
  }
  if (lookup.reason === "stale") {
    return buildDisabledSection("stale", {
      domainKey: lookup.domain.domainKey,
      observationKey: lookup.observation.observationKey,
      ageHours: lookup.ageHours,
      freshnessHours: lookup.observation.freshnessHours,
    });
  }

  const budget = Number.isFinite(config?.budgets?.workingProfile)
    ? config.budgets.workingProfile
    : DEFAULT_WORKING_PROFILE_BUDGET;
  const summary = truncateToBudget(lookup.observation.summary, budget);
  if (!summary) {
    return buildDisabledSection("empty_summary", {
      domainKey: lookup.domain.domainKey,
      observationKey: lookup.observation.observationKey,
    });
  }

  const text = `## ${SECTION_TITLE}\n\n${summary}`;
  return {
    title: SECTION_TITLE,
    text,
    trace: {
      enabled: true,
      reason: "included",
      domainKey: lookup.domain.domainKey,
      observationKey: lookup.observation.observationKey,
      ageHours: lookup.ageHours,
      freshnessHours: lookup.observation.freshnessHours,
      estimatedTokens: estimateTokens(text),
    },
  };
}
