import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPLACE_RETRY_CODES = new Set(["EEXIST", "EPERM", "ENOTEMPTY"]);

/**
 * Ensures a directory and every path component below root are real, private
 * directories. Missing components are created with owner-only permissions;
 * existing components below root are tightened to 0700.
 */
export async function ensurePrivateDirectory(directory, root = directory) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (resolvedRoot === path.parse(resolvedRoot).root
    || (!relative && resolvedDirectory !== resolvedRoot)
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error("private export directory must stay below its configured root");
  }

  const missing = [];
  let current = resolvedDirectory;
  while (true) {
    const stat = await lstat(current).catch(() => null);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("private export directory must be a real directory, not a symlink");
      }
      break;
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (const missingDirectory of missing.reverse()) {
    await mkdir(missingDirectory, { mode: 0o700 });
  }

  await chmod(resolvedRoot, 0o700);
  let child = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    child = path.join(child, segment);
    const stat = await lstat(child).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("private export directory must be a real directory, not a symlink");
    }
    await chmod(child, 0o700);
  }
}

/** Resolves a bundle-relative path while rejecting traversal and absolute paths. */
export function safeExportPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("export document path must be a non-empty relative path");
  }
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, fullPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("export document path must stay within the bundle directory");
  }
  return fullPath;
}

/** Writes a private file without following a symlink at the destination. */
export async function writePrivateAtomicFile(filePath, contents) {
  const existing = await lstat(filePath).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("export destination must be a regular file, not a symlink");
  }

  const temporary = `${filePath}.lore-export-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (!REPLACE_RETRY_CODES.has(error?.code)) {
        throw error;
      }
      const replacement = await lstat(filePath).catch(() => null);
      if (!replacement || replacement.isSymbolicLink() || !replacement.isFile()) {
        throw error;
      }
      await rm(filePath);
      await rename(temporary, filePath);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
