// Deleting a chat's files (Task 30).
//
// Before this, `sessions delete` removed rows and left every upload on disk
// forever. Now the files a session's messages reference are deleted with it —
// but only the ones nothing else still mentions:
//
//   • `chat.fork` copies message rows verbatim, so the fork and the original
//     both carry the same `media/…` path. Deleting one must not break the other.
//   • a path can be referenced from a message that was itself copied by a
//     rewind/edit, or re-sent later.
//
// So the rule is: collect the session's paths → delete the rows → for each
// path, ask the whole database → unlink only when no message mentions it.

import type { Store } from "../state/db.js";
import { parseMediaRefs } from "../../ui/src/media-refs.js";
import { deleteFiles, type PruneResult } from "./media-store.js";

/** Every media path this session's messages reference, in first-seen order. */
export function pathsInSession(store: Store, sessionId: string): string[] {
  const seen = new Set<string>();
  for (const content of store.messageContents(sessionId)) {
    for (const ref of parseMediaRefs(content).refs) {
      if (ref.path) seen.add(ref.path);
    }
  }
  return [...seen];
}

export interface DeleteSessionResult {
  deleted: boolean;
  messages: number;
  /** Files actually unlinked. */
  files: number;
  freedBytes: number;
  /** Files kept because another session still references them. */
  shared: number;
}

/**
 * Delete a session and the files it alone referenced.
 *
 * Order matters: the paths are read before the rows go, and the "is it still
 * mentioned" check runs after — that is what makes a fork safe.
 */
export function deleteSessionWithMedia(store: Store, workspace: string, key: string): DeleteSessionResult {
  const row = store.getSessionByKey(key);
  if (!row) return { deleted: false, messages: 0, files: 0, freedBytes: 0, shared: 0 };

  const paths = pathsInSession(store, row.id);
  const res = store.deleteSession(key);
  if (!res.deleted) return { deleted: false, messages: 0, files: 0, freedBytes: 0, shared: 0 };

  const orphans = paths.filter((p) => !store.anyMessageMentions(p));
  const shared = paths.length - orphans.length;
  const removed: PruneResult = deleteFiles(workspace, orphans);
  return {
    deleted: true,
    messages: res.messages,
    files: removed.removed.length,
    freedBytes: removed.freedBytes,
    shared,
  };
}

/** Is any file in the media tree still referenced? For `sc media prune --orphans`. */
export function referencedPaths(store: Store, paths: string[]): Set<string> {
  return new Set(paths.filter((p) => store.anyMessageMentions(p)));
}
