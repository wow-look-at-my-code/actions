import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";

interface PackageVersion {
  id: number;
  name: string; // sha256 digest
  created_at: string;
  metadata: { container: { tags: string[] } };
}

interface ImageRef {
  owner: string;
  packageName: string;
  tag: string;
}

function parseImageRef(image: string): ImageRef {
  const match = image.match(/^ghcr\.io\/([^/]+)\/(.+):(.+)$/);
  if (!match) {
    throw new Error(
      `Invalid image reference: ${image} (expected ghcr.io/<owner>/<package>:<tag>)`
    );
  }
  return { owner: match[1], packageName: match[2], tag: match[3] };
}

async function determineOwnerType(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string
): Promise<"org" | "user"> {
  const { data } = await octokit.rest.users.getByUsername({ username: owner });
  return data.type === "Organization" ? "org" : "user";
}

async function listAllVersions(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  packageName: string,
  ownerType: "org" | "user"
): Promise<PackageVersion[]> {
  const method =
    ownerType === "org"
      ? octokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg
      : octokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser;

  const params = {
    package_type: "container" as const,
    package_name: packageName,
    ...(ownerType === "org" ? { org: owner } : { username: owner }),
    per_page: 100,
    state: "active" as const,
  };

  return octokit.paginate(method, params) as Promise<PackageVersion[]>;
}

async function inspectManifest(imageWithDigest: string): Promise<string> {
  let stdout = "";
  await exec.exec("docker", ["manifest", "inspect", imageWithDigest], {
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
    },
    silent: true,
  });
  return stdout;
}

function collectDigestsFromManifest(manifest: Record<string, unknown>): Set<string> {
  const digests = new Set<string>();

  // Manifest index (multi-arch): has manifests array
  const manifests = manifest.manifests as
    | { digest: string }[]
    | undefined;
  if (Array.isArray(manifests)) {
    for (const m of manifests) {
      if (m.digest) digests.add(m.digest);
    }
  }

  // Single manifest: has config and layers
  const config = manifest.config as { digest?: string } | undefined;
  if (config?.digest) digests.add(config.digest);

  const layers = manifest.layers as { digest?: string }[] | undefined;
  if (Array.isArray(layers)) {
    for (const l of layers) {
      if (l.digest) digests.add(l.digest);
    }
  }

  return digests;
}

async function getReferencedDigests(
  owner: string,
  packageName: string,
  keptVersions: PackageVersion[]
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const imageBase = `ghcr.io/${owner}/${packageName}`;

  for (const v of keptVersions) {
    const ref = `${imageBase}@${v.name}`;
    core.info(`Inspecting manifest: ${ref}`);

    let raw: string;
    try {
      raw = await inspectManifest(ref);
    } catch {
      core.warning(
        `Failed to inspect manifest for ${v.name} — skipping untagged cleanup to be safe`
      );
      return new Set(["*"]); // sentinel: keep all untagged
    }

    const manifest = JSON.parse(raw) as Record<string, unknown>;
    const digests = collectDigestsFromManifest(manifest);

    // For manifest indexes, also inspect each sub-manifest
    const subManifests = manifest.manifests as
      | { digest: string }[]
      | undefined;
    if (Array.isArray(subManifests)) {
      for (const sub of subManifests) {
        const subRef = `${imageBase}@${sub.digest}`;
        try {
          const subRaw = await inspectManifest(subRef);
          const subManifest = JSON.parse(subRaw) as Record<string, unknown>;
          for (const d of collectDigestsFromManifest(subManifest)) {
            digests.add(d);
          }
        } catch {
          core.warning(`Failed to inspect sub-manifest ${sub.digest}`);
        }
      }
    }

    for (const d of digests) referenced.add(d);
  }

  return referenced;
}

async function deleteVersion(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  packageName: string,
  versionId: number,
  ownerType: "org" | "user"
): Promise<void> {
  if (ownerType === "org") {
    await octokit.rest.packages.deletePackageVersionForOrg({
      package_type: "container",
      package_name: packageName,
      org: owner,
      package_version_id: versionId,
    });
  } else {
    await octokit.rest.packages.deletePackageVersionForUser({
      package_type: "container",
      package_name: packageName,
      username: owner,
      package_version_id: versionId,
    });
  }
}

async function run(): Promise<void> {
  const image = core.getInput("image", { required: true });
  const keepStr = core.getInput("keep", { required: true });
  const prune = core.getInput("prune") !== "false";

  const token = process.env.GHCR_WRITE_TOKEN;
  if (!token) {
    throw new Error("GHCR_WRITE_TOKEN environment variable is not set. Run ghcr-login first.");
  }

  const keep = parseInt(keepStr, 10);
  if (!Number.isFinite(keep) || keep < 1) {
    throw new Error(`'keep' must be a positive integer, got: ${keepStr}`);
  }

  const { owner, packageName, tag } = parseImageRef(image);
  core.info(`Image: ghcr.io/${owner}/${packageName}:${tag}`);
  core.info(`Keeping last ${keep} tagged version(s), prune=${prune}`);

  // Fetch all versions
  const octokit = github.getOctokit(token);
  const ownerType = await determineOwnerType(octokit, owner);
  core.info(`Owner type: ${ownerType}`);

  const allVersions = await listAllVersions(
    octokit,
    owner,
    packageName,
    ownerType
  );
  core.info(`Total versions: ${allVersions.length}`);

  // Split tagged vs untagged
  const tagged: PackageVersion[] = [];
  const untagged: PackageVersion[] = [];
  for (const v of allVersions) {
    if (v.metadata.container.tags.length > 0) {
      tagged.push(v);
    } else {
      untagged.push(v);
    }
  }

  // Sort tagged by creation date descending (newest first)
  tagged.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  core.info(`Tagged versions: ${tagged.length}, untagged versions: ${untagged.length}`);

  if (tagged.length <= keep) {
    core.info(
      `Only ${tagged.length} tagged version(s) exist, nothing to prune`
    );
    return;
  }

  const keptTagged = tagged.slice(0, keep);
  const deletableTagged = tagged.slice(keep);

  for (const v of keptTagged) {
    core.info(`  Keeping: ${v.metadata.container.tags.join(", ")} (${v.name})`);
  }
  for (const v of deletableTagged) {
    core.info(`  Pruning: ${v.metadata.container.tags.join(", ")} (${v.name})`);
  }

  // Find referenced digests from kept versions
  const referencedDigests = await getReferencedDigests(
    owner,
    packageName,
    keptTagged
  );

  const keepAllUntagged = referencedDigests.has("*");
  let deletableUntagged: PackageVersion[] = [];

  if (keepAllUntagged) {
    core.warning(
      "Manifest inspection failed — keeping all untagged versions as a safety measure"
    );
  } else {
    for (const v of untagged) {
      if (referencedDigests.has(v.name)) {
        core.info(`  Keeping untagged: ${v.name} (referenced by kept version)`);
      } else {
        deletableUntagged.push(v);
      }
    }
    core.info(`Orphaned untagged versions to prune: ${deletableUntagged.length}`);
  }

  const totalToDelete = deletableTagged.length + deletableUntagged.length;
  if (totalToDelete === 0) {
    core.info("Nothing to delete");
    return;
  }

  if (!prune) {
    core.info(
      `Dry-run: would delete ${deletableTagged.length} tagged + ${deletableUntagged.length} untagged version(s)`
    );
    return;
  }

  // Delete old tagged versions
  let deleted = 0;
  for (const v of deletableTagged) {
    try {
      await deleteVersion(octokit, owner, packageName, v.id, ownerType);
      deleted++;
      core.info(`Deleted tagged: ${v.metadata.container.tags.join(", ")} (${v.name})`);
    } catch (error) {
      core.warning(
        `Failed to delete version ${v.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Delete orphaned untagged versions
  for (const v of deletableUntagged) {
    try {
      await deleteVersion(octokit, owner, packageName, v.id, ownerType);
      deleted++;
      core.info(`Deleted untagged: ${v.name}`);
    } catch (error) {
      core.warning(
        `Failed to delete version ${v.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  core.info(`Pruned ${deleted}/${totalToDelete} version(s)`);
}

// A GitHub API rate limit (HTTP 403 or 429 whose message mentions the rate
// limit — octokit's RequestError carries .status and .message) must not fail
// the job: this step trails an already-successful image publish, and pruning
// is housekeeping that self-heals on the next run. Every other error stays
// fatal.
function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  return (
    (status === 403 || status === 429) &&
    typeof message === "string" &&
    /rate limit/i.test(message)
  );
}

run().catch((error) => {
  if (isRateLimitError(error)) {
    core.warning(
      `Skipping prune of ${core.getInput("image")}: GitHub API rate limit hit (${
        (error as { message: string }).message
      }). Old versions were left in place; the next run will prune them.`
    );
    return;
  }
  core.setFailed(error instanceof Error ? error.message : String(error));
});
