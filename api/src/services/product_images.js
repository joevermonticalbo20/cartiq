// Product photo storage (dashboard uploads).
//
// Cropped photos live in `productImages/{productId}` as a base64 string. The
// product doc only ever carries the SERVED URL, so catalog payloads stay a
// few KB for the POS app instead of megabytes of data URLs. The GET endpoint
// is public on purpose: <img> tags on the dashboard and the POS cards cannot
// send an auth header.
import { db as prisma } from "../firestore.js";

export const IMAGE_MAX_BYTES = 512 * 1024;
export const IMAGE_PREFIX = {
  "image/jpeg": "/9j/",
  "image/png": "iVBOR",
  "image/webp": "UklGR",
};

export const imageDoc = (id) => prisma.collection("productImages").doc(String(id));

/** Absolute URL of the public image endpoint, cache-busted by upload time. */
export function imageUrlFor(req, productId, updatedMs) {
  const base = `${req.protocol}://${req.get("host")}/api`;
  return `${base}/products/${productId}/image?v=${updatedMs}`;
}

/** productId -> uploadedAt(ms) for every product that has an uploaded image. */
export async function uploadedImageTimes() {
  const snap = await prisma.collection("productImages").get();
  const out = new Map();
  for (const doc of snap.docs) {
    const ms = Number(doc.data()?.updatedAtMs);
    out.set(Number(doc.id), Number.isFinite(ms) ? ms : Date.now());
  }
  return out;
}

/** The URL a product should serve: uploaded photo first, pasted URL second. */
export function servedImageUrl(req, product, times) {
  const uploaded = times?.get(Number(product.id));
  if (uploaded) return imageUrlFor(req, product.id, uploaded);
  return product.imageUrl ?? null;
}
