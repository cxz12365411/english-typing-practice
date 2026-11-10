import { createHash } from "node:crypto";
import { constants, readFileSync, realpathSync, statSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteDatabase } from "./database.js";
import { revalidateAuthenticatedActor, type UserRow } from "./auth.js";
import { ApiError } from "./errors.js";
import { requirePracticeAccess } from "./membership.js";

const VOICE_IDS = ["01", "02", "03", "04", "05"] as const;
const HASH = /^[a-f0-9]{64}$/;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_AUDIO_DIR = fileURLToPath(new URL("../audio/", import.meta.url));

interface Voice { id: string; name: string }
interface Asset {
  textKey: string;
  originalText: string;
  spokenText: string;
  voiceId: string;
  path: string;
  sha256: string;
  duration: number;
  sampleRate: number;
  format: "mp3";
  qaStatus: "passed" | "review";
}
interface AudioLibrary {
  root: string;
  voices: Voice[];
  assets: Map<string, Map<string, Asset>>;
  previews: Map<string, Asset>;
}
interface PublicItem { id: string; english: string }

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAsset(value: unknown, prefix: "voices" | "previews"): Asset {
  if (!record(value) || typeof value.textKey !== "string" || !HASH.test(value.textKey)
    || typeof value.originalText !== "string" || !value.originalText.length || value.originalText.length > 20_000
    || digest(value.originalText) !== value.textKey || typeof value.spokenText !== "string" || !value.spokenText.length
    || typeof value.voiceId !== "string" || !VOICE_IDS.includes(value.voiceId as typeof VOICE_IDS[number])
    || value.path !== `${prefix}/${value.voiceId}/${value.textKey}.mp3`
    || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    || typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 300
    || value.sampleRate !== 24_000 || value.format !== "mp3"
    || (value.qaStatus !== "passed" && value.qaStatus !== "review")) {
    throw new Error("Invalid speech audio asset");
  }
  return value as unknown as Asset;
}

function isInside(root: string, file: string): boolean {
  return file.startsWith(`${root}${path.sep}`);
}

/** An immutable release bundle is read once. Invalid or absent bundles never stop the main app. */
function loadLibrary(directory: string): AudioLibrary {
  if (!path.isAbsolute(directory)) throw new Error("SPEECH_AUDIO_DIR must be absolute");
  const root = realpathSync(directory);
  const manifestPath = path.join(root, "manifest.json");
  const resolvedManifest = realpathSync(manifestPath);
  if (!isInside(root, resolvedManifest) || statSync(resolvedManifest).size > MAX_MANIFEST_BYTES) {
    throw new Error("Invalid speech manifest path or size");
  }
  const manifest: unknown = JSON.parse(readFileSync(resolvedManifest, "utf8"));
  if (!record(manifest) || manifest.manifestVersion !== 1 || !Array.isArray(manifest.voices)
    || manifest.voices.length !== VOICE_IDS.length || !Array.isArray(manifest.assets)
    || manifest.assets.length > 100_000 || !Array.isArray(manifest.previews)
    || manifest.previews.length !== VOICE_IDS.length) throw new Error("Invalid speech manifest");
  const voices: Voice[] = manifest.voices.map((voice: unknown, index: number) => {
    if (!record(voice) || voice.id !== VOICE_IDS[index] || typeof voice.name !== "string"
      || !voice.name.trim() || voice.name.length > 80 || /[\x00-\x1f\x7f]/.test(voice.name)) {
      throw new Error("Invalid speech voice metadata");
    }
    return { id: voice.id as string, name: voice.name };
  });
  const assets = new Map<string, Map<string, Asset>>();
  const previews = new Map<string, Asset>();
  const seen = new Set<string>();
  for (const [prefix, rows] of [["voices", manifest.assets], ["previews", manifest.previews]] as const) {
    for (const row of rows) {
      const asset = validateAsset(row, prefix);
      const key = `${prefix}/${asset.voiceId}/${asset.textKey}`;
      if (seen.has(key)) throw new Error("Duplicate speech audio asset");
      seen.add(key);
      if (asset.qaStatus !== "passed") continue;
      const file = realpathSync(path.join(root, asset.path));
      const stat = statSync(file);
      if (!isInside(root, file) || !stat.isFile() || stat.size < 1 || stat.size > MAX_AUDIO_BYTES) {
        throw new Error("Invalid speech audio file");
      }
      if (digest(readFileSync(file)) !== asset.sha256) throw new Error("Speech audio checksum mismatch");
      if (prefix === "previews") {
        if (previews.has(asset.voiceId)) throw new Error("Duplicate speech voice preview");
        previews.set(asset.voiceId, asset);
      } else {
        const byVoice = assets.get(asset.textKey) ?? new Map<string, Asset>();
        byVoice.set(asset.voiceId, asset);
        assets.set(asset.textKey, byVoice);
      }
    }
  }
  if (previews.size !== VOICE_IDS.length || !assets.size) throw new Error("Incomplete speech audio bundle");
  return { root, voices, assets, previews };
}

function unavailable(): never {
  throw new ApiError(404, "SPEECH_AUDIO_UNAVAILABLE", "所选朗读音频暂不可用，请使用系统朗读");
}

/** Verify content on every read so replacement/corruption cannot serve unintended audio. */
async function readAsset(library: AudioLibrary, asset: Asset): Promise<Buffer> {
  let handle;
  try {
    const filename = await realpath(path.join(library.root, asset.path));
    if (!isInside(library.root, filename)) return unavailable();
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_AUDIO_BYTES) return unavailable();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_AUDIO_BYTES || digest(bytes) !== asset.sha256) return unavailable();
    return bytes;
  } catch {
    return unavailable();
  } finally {
    await handle?.close();
  }
}

function rangeBounds(header: string, length: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const left = match[1] ? Number(match[1]) : null;
  const right = match[2] ? Number(match[2]) : null;
  if ((left !== null && !Number.isSafeInteger(left)) || (right !== null && !Number.isSafeInteger(right))) return null;
  if (left === null) {
    if (right === null || right <= 0) return null;
    return [Math.max(0, length - right), length - 1];
  }
  if (left >= length || (right !== null && right < left)) return null;
  return [left, Math.min(right ?? length - 1, length - 1)];
}

async function sendAudio(
  request: FastifyRequest, reply: FastifyReply, library: AudioLibrary, asset: Asset, revalidate: () => void
) {
  const bytes = await readAsset(library, asset);
  // Disk reads yield: entitlement/content revocation during I/O must win before delivery.
  revalidate();
  const etag = `"${asset.sha256}"`;
  reply.type("audio/mpeg").header("Accept-Ranges", "bytes").header("ETag", etag);
  const range = request.headers.range;
  if (range && (!request.headers["if-range"] || request.headers["if-range"] === etag)) {
    const bounds = rangeBounds(range, bytes.length);
    if (!bounds) return reply.code(416).header("Content-Range", `bytes */${bytes.length}`).send();
    const [start, end] = bounds;
    reply.code(206).header("Content-Range", `bytes ${start}-${end}/${bytes.length}`)
      .header("Content-Length", end - start + 1);
    // Fastify's automatic HEAD route suppresses the payload while preserving its length.
    return reply.send(bytes.subarray(start, end + 1));
  }
  reply.header("Content-Length", bytes.length);
  return reply.send(bytes);
}

export async function registerSpeechRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  options: { membershipEnabled: boolean; speechAudioDir?: string }
): Promise<void> {
  let library: AudioLibrary | null = null;
  try { library = loadLibrary(options.speechAudioDir ?? DEFAULT_AUDIO_DIR); }
  catch (error) {
    // A missing optional bundle is expected on existing installations and test setups.
    if (options.speechAudioDir || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      app.log.warn({ err: error }, "Speech audio bundle unavailable; system narration remains available");
    }
  }
  const revalidateAccess = (request: FastifyRequest, expected: UserRow) => {
    // Refresh the session's actor as well as the membership row after asynchronous I/O.
    const current = revalidateAuthenticatedActor(db, request, expected);
    request.authSession!.user = current;
    requirePracticeAccess(db, request, options.membershipEnabled);
  };
  app.get("/api/speech/catalog", async (request) => {
    requirePracticeAccess(db, request, options.membershipEnabled);
    if (!library) return { available: false, voices: [], entries: [] };
    const items = db.prepare(`SELECT i.id, i.english FROM items i JOIN categories c ON c.id = i.category_id
      WHERE i.status = 'published' AND c.status = 'published' ORDER BY i.id`).all() as PublicItem[];
    const entries = items.flatMap((item) => {
      const textKey = digest(item.english);
      const covered = library!.assets.get(textKey);
      if (!covered) return [];
      return [{ itemId: item.id, english: item.english, textKey, voiceIds: [...covered.keys()].sort() }];
    });
    return {
      available: entries.length > 0,
      voices: library.voices.map((voice) => ({ ...voice, previewUrl: `/api/speech/preview/${voice.id}` })),
      entries
    };
  });
  app.get<{ Params: { voice: string }; }>("/api/speech/preview/:voice", async (request, reply) => {
    const actor = requirePracticeAccess(db, request, options.membershipEnabled);
    const asset = library?.previews.get(request.params.voice);
    if (!library || !asset) return unavailable();
    return sendAudio(request, reply, library, asset, () => {
      revalidateAccess(request, actor);
    });
  });
  app.get<{ Params: { voice: string; textKey: string }; Querystring: { itemId?: unknown } }>(
    "/api/speech/audio/:voice/:textKey", async (request, reply) => {
      const actor = requirePracticeAccess(db, request, options.membershipEnabled);
      const { voice, textKey } = request.params;
      const itemId = request.query.itemId;
      if (!library || !HASH.test(textKey) || typeof itemId !== "string" || !itemId.length || itemId.length > 200) {
        return unavailable();
      }
      const asset = library.assets.get(textKey)?.get(voice);
      if (!asset) return unavailable();
      const revalidate = () => {
        revalidateAccess(request, actor);
        const current = db.prepare(`SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id
          WHERE i.id = ? AND i.english = ? COLLATE BINARY AND i.status = 'published' AND c.status = 'published'`)
          .get(itemId, asset.originalText);
        if (!current) return unavailable();
      };
      revalidate();
      return sendAudio(request, reply, library, asset, revalidate);
    }
  );
}
