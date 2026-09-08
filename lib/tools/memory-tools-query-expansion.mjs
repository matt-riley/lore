import { expandRetrievalQueryWithLocalInference } from "../inference/local-inference-augmentation.mjs";
import { recallHasQueryEvidence } from "../context/recall-query-evidence.mjs";

export { recallHasQueryEvidence };

export async function resolveRetrievalPrompt(runtime, prompt) {
  if (runtime.config?.localInference?.queryExpansion?.enabled !== true) {
    return {
      query: prompt,
      addedTerms: [],
      requested: false,
      used: false,
      error: null,
    };
  }
  if (runtime.config?.localInference?.enabled !== true) {
    return {
      query: prompt,
      addedTerms: [],
      requested: true,
      used: false,
      error: "provider disabled",
    };
  }
  try {
    const expanded = await expandRetrievalQueryWithLocalInference({
      config: runtime.config.localInference,
      prompt,
      deterministicQuery: prompt,
      fetchImpl: runtime.localInferenceFetch,
    });
    return {
      ...expanded,
      requested: true,
      error: null,
    };
  } catch (error) {
    return {
      query: prompt,
      addedTerms: [],
      requested: true,
      used: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
