export function buildMemoryPortableBundleTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    buildPortableBundleRequest,
    writePortableBundle,
    formatPortableBundleResult,
    buildOkfBundleDocuments,
    writeOkfBundle,
    formatOkfBundleResult,
    createPortableBundle,
    mapImprovementArtifactRow,
    importOkfPortableBundle,
  } = context;
  return toolDef("memory_portable_bundle", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }

      const request = buildPortableBundleRequest(args, runtime);

      if (request.action === "import") {
        return importOkfPortableBundle({ runtime, invocation, request });
      }

      const improvementArtifacts = runtime.db.listImprovementArtifacts({
        reviewState: "approved",
        hasProposal: true,
        limit: request.limit,
      });

      if (request.format === "okf") {
        const documents = buildOkfBundleDocuments({
          repository: request.repository,
          improvementArtifacts: improvementArtifacts.map(mapImprovementArtifactRow),
        });
        await writeOkfBundle(request.bundlePath, documents);
        return formatOkfBundleResult({
          bundleDir: request.bundlePath,
          repository: request.repository,
          exportedArtifactCount: improvementArtifacts.length,
        });
      }

      const portableBundle = createPortableBundle({
        repository: request.repository,
        improvementArtifacts,
      });
      await writePortableBundle(request.bundlePath, portableBundle);
      return formatPortableBundleResult({
        portableBundle,
        bundlePath: request.bundlePath,
        repository: request.repository,
      });
    },
  });
}

/**
 * action=import handler for memory_portable_bundle (format=okf only). Reads
 * an OKF bundle directory from disk and retains each concept as a
 * type=okf_concept semantic memory row (see okf-bundle-import.mjs). Passes
 * maxConcepts=request.limit and includeGraph=false into readOkfBundle so a
 * large/malicious bundle directory can't force unbounded file reads,
 * parsing, or link-graph construction -- only up to request.limit concept
 * files are actually read, not just capped after the fact.
 */
