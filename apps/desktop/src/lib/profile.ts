// The person using the app: shown on the welcome screen and edited in Settings → Your details.

export interface UserProfile {
  name: string;
  alias: string;
  storeName: string;
  /** Small square picture as a data URL (resized when uploaded). */
  avatar: string;
}

const KEY = "sg.user";
export const EMPTY_PROFILE: UserProfile = { name: "", alias: "", storeName: "", avatar: "" };

export function loadProfile(): UserProfile {
  try {
    return { ...EMPTY_PROFILE, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function saveProfile(p: UserProfile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* preference only */
  }
}

/** What to call the user: their nickname, else their first name. */
export function greetingName(p: UserProfile): string {
  return p.alias.trim() || p.name.trim().split(/\s+/)[0] || "";
}

export function initials(p: UserProfile): string {
  const src = (p.name.trim() || p.alias.trim()).split(/\s+/).filter(Boolean);
  return (src.length > 1 ? src[0][0] + src[src.length - 1][0] : src[0]?.slice(0, 2) ?? "").toUpperCase();
}

/** Crops an image to a centred square and scales it to `size` px, as a PNG data URL. */
export async function avatarFromBytes(bytes: Uint8Array, size = 192): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}
