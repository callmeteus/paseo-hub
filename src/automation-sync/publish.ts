import { z } from "zod";
import { planAutomationTree, type LocalBlob, type TreeChange } from "./tree.js";

const RefSchema = z.object({ object: z.object({ sha: z.string().min(1) }) });
const CommitSchema = z.object({
  sha: z.string().min(1),
  tree: z.object({ sha: z.string().min(1) }),
});
const TreeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string().optional(),
      type: z.string().optional(),
      sha: z.string().optional(),
    }),
  ),
});
const CreatedSchema = z.object({ sha: z.string().min(1) });

export interface GitTreeClient {
  readHead(input: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<{ commitSha: string; treeSha: string }>;
  readTree(input: {
    owner: string;
    repo: string;
    treeSha: string;
  }): Promise<readonly { path: string; sha: string }[]>;
  commit(input: {
    owner: string;
    repo: string;
    branch: string;
    parentSha: string;
    baseTreeSha: string;
    message: string;
    changes: readonly TreeChange[];
  }): Promise<string>;
}

export interface GitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export function gitTreeClient(github: GitHubRequester): GitTreeClient {
  return {
    async readHead({ owner, repo, branch }) {
      const ref = RefSchema.parse(
        (
          await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            owner,
            repo,
            ref: `heads/${branch}`,
          })
        ).data,
      );
      const commit = CommitSchema.parse(
        (
          await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
            owner,
            repo,
            commit_sha: ref.object.sha,
          })
        ).data,
      );
      return { commitSha: commit.sha, treeSha: commit.tree.sha };
    },
    async readTree({ owner, repo, treeSha }) {
      const tree = TreeSchema.parse(
        (
          await github.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
            owner,
            repo,
            tree_sha: treeSha,
            recursive: "1",
          })
        ).data,
      );
      if (tree.truncated === true) {
        throw new Error(
          "GitHub returned a truncated tree, so the sync did not change the repository",
        );
      }
      return tree.tree.flatMap((entry) =>
        entry.type === "blob" && entry.path !== undefined && entry.sha !== undefined
          ? [{ path: entry.path, sha: entry.sha }]
          : [],
      );
    },
    async commit({ owner, repo, branch, parentSha, baseTreeSha, message, changes }) {
      const tree = CreatedSchema.parse(
        (
          await github.request("POST /repos/{owner}/{repo}/git/trees", {
            owner,
            repo,
            base_tree: baseTreeSha,
            tree: changes.map((change) =>
              "sha" in change
                ? { path: change.path, mode: change.mode, type: change.type, sha: null }
                : {
                    path: change.path,
                    mode: change.mode,
                    type: change.type,
                    content: change.content,
                  },
            ),
          })
        ).data,
      );
      const created = CreatedSchema.parse(
        (
          await github.request("POST /repos/{owner}/{repo}/git/commits", {
            owner,
            repo,
            message,
            tree: tree.sha,
            parents: [parentSha],
          })
        ).data,
      );
      await github.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: created.sha,
      });
      return created.sha;
    },
  };
}

export async function publishAutomationTree(
  client: GitTreeClient,
  input: {
    owner: string;
    repo: string;
    branch: string;
    files: readonly LocalBlob[];
    prefixes?: readonly string[];
    message: string;
  },
): Promise<{ status: "unchanged" | "committed"; commitSha: string }> {
  const head = await client.readHead(input);
  const remote = await client.readTree({ ...input, treeSha: head.treeSha });
  const changes = planAutomationTree(remote, input.files, input.prefixes);
  if (changes.length === 0) return { status: "unchanged", commitSha: head.commitSha };
  const commitSha = await client.commit({
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    parentSha: head.commitSha,
    baseTreeSha: head.treeSha,
    message: input.message,
    changes,
  });
  return { status: "committed", commitSha };
}
