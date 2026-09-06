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
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["export", "import"],
          description: "Export a portable bundle, or import (format=okf only) an OKF bundle directory into semantic memory",
        },
        repository: {
          type: "string",
          description: "Optional repository override",
        },
        bundlePath: {
          type: "string",
          description: "Optional repository-relative or absolute path for reading/writing bundles. For format=okf this is a directory root; for format=json (default) this is a single file path. Required for action=import.",
        },
        limit: {
          type: "number",
          description: "Maximum records to export/import per dataset",
        },
        format: {
          type: "string",
          enum: ["json", "okf"],
          description: "Bundle output format. \"json\" (default) writes a single signed JSON file. \"okf\" writes an Open Knowledge Format v0.1 markdown+frontmatter bundle directory (one concept file per artifact plus an index.md) for human/agent-readable, git-diffable exchange. action=import currently supports format=okf only.",
        },
        confidence: {
          type: "number",
          description: "Optional confidence override for action=import (default 0.7 -- lower than self-authored memory_save's 0.9, since imported content is externally sourced)",
        },
      },
    },
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
