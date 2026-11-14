// Conversations with the agents between devices.
//
//   v1/chats/index.json     which conversations exist and when each last changed; what was deleted
//   v1/chats/<id>.json      one conversation
//   v1/chats.version.json   a few bytes that change whenever the index does, so that a sync with
//                           nothing new costs one tiny request
//
// A conversation is one object, so a long one is uploaded again only when it has grown. The newest
// copy of a conversation wins as a whole: continuing the same one on two devices between syncs
// keeps the later of the two. Deletions travel as tombstones. Keys never travel: a conversation
// holds what was said and which tools ran, not the credentials of the provider that answered.
import { db } from '../db';
import type { ChatThread } from '../types';
import { fingerprint } from './hash';
import type { S3Store } from './s3';

const INDEX_KEY = 'v1/chats/index.json';
const VERSION_KEY = 'v1/chats.version.json';
const STATE_KEY = 'zakladka:chatSync';
// Ids of old conversations contain a colon; object names stay plain.
const threadKey = (id: string) => `v1/chats/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;

interface ChatIndex {
  version: 1;
  /** Conversation id → when it last changed. */
  threads: Record<string, number>;
  /** Conversation id → when it was deleted. */
  deleted: Record<string, number>;
}

interface LocalState {
  pulledAt: number;
  digest: string;
}

function readState(): LocalState {
  try {
    return { pulledAt: 0, digest: '', ...JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') };
  } catch {
    return { pulledAt: 0, digest: '' };
  }
}

const digestOf = (threads: Record<string, number>, deleted: Record<string, number>): string =>
  fingerprint(
    [...Object.entries(threads).map(([id, at]) => `t:${id}:${at}`), ...Object.entries(deleted).map(([id, at]) => `x:${id}:${at}`)]
      .sort()
      .join('\n'),
  );

/** One round of conversation sync. Returns how many conversations changed here and how many were uploaded. */
export async function syncChats(store: S3Store, step: (text: string) => void): Promise<{ pulled: number; pushed: number }> {
  // Empty conversations (opened, nothing asked) are not worth carrying around.
  const mine: Record<string, number> = {};
  await db.chats.each((t) => {
    if (t.ui.length) mine[t.id] = t.updatedAt;
  });
  const tombs = Object.fromEntries((await db.chatTombs.toArray()).map((t) => [t.id, t.deletedAt]));
  const state = readState();
  const version = await store.getJson<{ at: number }>(VERSION_KEY);
  const remoteAt = version?.at ?? 0;
  if (remoteAt === state.pulledAt && digestOf(mine, tombs) === state.digest) return { pulled: 0, pushed: 0 };

  const index: ChatIndex = (version && (await store.getJson<ChatIndex>(INDEX_KEY))) || { version: 1, threads: {}, deleted: {} };
  const remoteDigest = digestOf(index.threads, index.deleted);
  const deleted: Record<string, number> = { ...index.deleted };
  for (const [id, at] of Object.entries(tombs)) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const gone = (id: string, changedAt: number) => (deleted[id] ?? 0) >= changedAt;

  let pulled = 0;
  let pushed = 0;

  // Deleted elsewhere, and not continued here since.
  for (const [id, at] of Object.entries(mine)) {
    if (!gone(id, at)) continue;
    await db.chats.delete(id);
    delete mine[id];
    pulled++;
  }
  await db.chatTombs.bulkPut(Object.entries(deleted).map(([id, deletedAt]) => ({ id, deletedAt })));

  // Newer there.
  const wanted = Object.entries(index.threads).filter(([id, at]) => !gone(id, at) && (mine[id] ?? 0) < at);
  if (wanted.length) step('Завантажую розмови з AI…');
  for (const [id, at] of wanted) {
    const thread = await store.getJson<ChatThread>(threadKey(id));
    if (!thread?.ui?.length) continue;
    // It may have been continued here while the download ran.
    const current = await db.chats.get(id);
    if (current && current.updatedAt >= thread.updatedAt) continue;
    await db.chats.put({ ...thread, id });
    mine[id] = at;
    pulled++;
  }

  // Newer here.
  const threads: Record<string, number> = {};
  for (const [id, at] of Object.entries(index.threads)) {
    if (gone(id, at)) await store.delete(threadKey(id));
    else threads[id] = at;
  }
  const fresh = Object.entries(mine).filter(([id, at]) => (threads[id] ?? 0) < at);
  if (fresh.length) step('Вивантажую розмови з AI…');
  for (const [id] of fresh) {
    const thread = await db.chats.get(id);
    if (!thread?.ui.length) continue;
    await store.putJson(threadKey(id), thread);
    threads[id] = thread.updatedAt;
    mine[id] = thread.updatedAt;
    pushed++;
  }

  let at = remoteAt;
  if (digestOf(threads, deleted) !== remoteDigest) {
    at = Math.max(Date.now(), remoteAt + 1);
    await store.putJson(INDEX_KEY, { version: 1, threads, deleted } satisfies ChatIndex);
    await store.putJson(VERSION_KEY, { at });
  }
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ pulledAt: at, digest: digestOf(mine, deleted) } satisfies LocalState));
  } catch {
    // Without storage the next sync simply compares everything again.
  }
  return { pulled, pushed };
}
