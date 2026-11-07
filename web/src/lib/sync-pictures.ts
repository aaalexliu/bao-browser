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

export async function fitPictureBody<T extends { shots?: { png: string }[]; heal?: unknown }>(source: T): Promise<{ body: T; omittedPictures: number; tooLarge: boolean }> {
  const body = structuredClone(source);
  let omittedPictures = 0;
  if (body.shots) {
    const shots: { png: string }[] = [];
    for (const shot of body.shots) {
      const bytes = await syncPicture(Buffer.from(shot.png, "base64"));
      if (bytes) shots.push({ ...shot, png: bytes.toString("base64") });
      else omittedPictures++;
    }
    body.shots = shots;
  }
  const size = (): number => Buffer.byteLength(JSON.stringify(body));
  if (size() >= SYNC_BODY_LIMIT && body.heal && typeof body.heal === "object" && !isSealedArtifact(body.heal)) {
    const heal = body.heal as { screenshot?: unknown };
    if (typeof heal.screenshot === "string" && !isSealedArtifact(heal.screenshot)) {
      const bytes = await syncPicture(Buffer.from(heal.screenshot, "base64"));
      if (bytes) heal.screenshot = bytes.toString("base64");
      if (!bytes || size() >= SYNC_BODY_LIMIT) {
        delete heal.screenshot;
        omittedPictures++;
      }
    }
  }
  while (size() >= SYNC_BODY_LIMIT && body.shots?.length) {
    body.shots.pop();
    omittedPictures++;
  }
  return { body, omittedPictures, tooLarge: size() >= SYNC_BODY_LIMIT };
}
