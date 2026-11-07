import sharp from "sharp";
import { isSealedArtifact } from "../../../shared/saved-secrets";

export const SYNC_BODY_LIMIT = 4_000_000;

export async function syncPicture(bytes: Buffer): Promise<Buffer | undefined> {
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const meta = await image.metadata();
    if (meta.format !== "png" && meta.format !== "jpeg") return;
    return await image.resize({ width: 720, height: 480, fit: "inside", withoutEnlargement: true }).flatten({ background: "white" }).jpeg({ quality: 70 }).toBuffer();
  } catch {
    return;
  }
}

export async function fitPictureBody<T>(source: T): Promise<{ body: T; omittedPictures: number; tooLarge: boolean }> {
  const body = structuredClone(source);
  const pictures: { owner: Record<string, unknown>; key: string }[] = [];
  let omittedPictures = 0;
  const walk = async (value: unknown): Promise<void> => {
    if (isSealedArtifact(value)) return;
    if (Array.isArray(value)) {
      for (const child of value) await walk(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const owner = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(owner)) {
      if ((key === "png" || key === "screenshot") && typeof child === "string") {
        const bytes = await syncPicture(Buffer.from(child, "base64"));
        if (bytes) {
          owner[key] = bytes.toString("base64");
          pictures.push({ owner, key });
        } else {
          delete owner[key];
          omittedPictures++;
        }
      } else await walk(child);
    }
  };
  await walk(body);
  const cleanShots = (): void => {
    const record = body as { shots?: { png?: string }[] };
    if (Array.isArray(record.shots)) record.shots = record.shots.filter((shot) => shot.png);
  };
  cleanShots();
  let size = Buffer.byteLength(JSON.stringify(body));
  while (size >= SYNC_BODY_LIMIT && pictures.length) {
    const picture = pictures.pop()!;
    delete picture.owner[picture.key];
    omittedPictures++;
    cleanShots();
    size = Buffer.byteLength(JSON.stringify(body));
  }
  return { body, omittedPictures, tooLarge: size >= SYNC_BODY_LIMIT };
}
