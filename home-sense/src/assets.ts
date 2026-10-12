import { resolveUrl } from "./serverConfig";
export type AssetFile = { name: string; data: ArrayBuffer };
export type ModelAsset = {
  id: string;
  name: string;
  files: AssetFile[];
  scale: number;
  upAxis?: "Y" | "Z";
  yaw?: number;
  created: string;
  remoteFiles?: RemoteFile[];
};
function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("haven-scans", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("models", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveModel(a: ModelAsset) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction("models", "readwrite");
    t.objectStore("models").put(a);
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}
export async function listModels() {
  const db = await open();
  return new Promise<ModelAsset[]>((resolve, reject) => {
    const r = db.transaction("models").objectStore("models").getAll();
    r.onsuccess = () => {
      db.close();
      resolve(r.result);
    };
    r.onerror = () => {
      db.close();
      reject(r.error);
    };
  });
}

export type RemoteFile = { name: string; size: number; sha256: string };
async function response(r: Response) {
  if (!r.ok) {
    let message = "Scan service request failed";
    try {
      message = (await r.json()).error || message;
    } catch {}
    throw Error(message);
  }
  return r;
}
async function digest(data: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function saveSharedModel(a: ModelAsset) {
  if (!a.files.length && a.remoteFiles) {
    const prepared = await (
      await response(
        await fetch(resolveUrl("/api/models"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...a, files: a.remoteFiles }),
        }),
      )
    ).json();
    if (prepared.missing.length)
      throw Error(
        "Workspace scan files are missing. Import the original scan again.",
      );
    return;
  }
  const files = await Promise.all(
    a.files.map(async (f) => ({
      name: f.name,
      size: f.data.byteLength,
      sha256: await digest(f.data),
    })),
  );
  const prepared = await (
    await response(
      await fetch(resolveUrl("/api/models"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: a.id,
          name: a.name,
          scale: a.scale,
          upAxis: a.upAxis || "Y",
          yaw: a.yaw || 0,
          created: a.created,
          files,
        }),
      }),
    )
  ).json();
  for (const index of prepared.missing as number[])
    await response(
      await fetch(resolveUrl(`/api/models/${encodeURIComponent(a.id)}/file/${index}`), {
        method: "POST",
        body: a.files[index].data,
      }),
    );
  await saveModel(a);
}
export async function listSharedModels(): Promise<ModelAsset[]> {
  type Manifest = Omit<ModelAsset, "files"> & { files: RemoteFile[] };
  const metadata: Manifest[] = await (
    await response(await fetch(resolveUrl("/api/models")))
  ).json();
  const local = await listModels();
  for (const old of local) {
    if (metadata.some((m) => m.id === old.id)) continue;
    await saveSharedModel(old);
    const files = await Promise.all(
      old.files.map(async (f) => ({
        name: f.name,
        size: f.data.byteLength,
        sha256: await digest(f.data),
      })),
    );
    metadata.push({ ...old, files });
  }
  return metadata.map((m) => ({ ...m, remoteFiles: m.files, files: [] }));
}
export async function hydrateModel(a: ModelAsset): Promise<ModelAsset> {
  if (a.files.length) return a;
  if (!a.remoteFiles) throw Error("Model file manifest is missing");
  const files = await Promise.all(
    a.remoteFiles.map(async (f, index) => {
      const data = await (
        await response(
          await fetch(resolveUrl(`/api/models/${encodeURIComponent(a.id)}/file/${index}`)),
        )
      ).arrayBuffer();
      if (data.byteLength !== f.size || (await digest(data)) !== f.sha256)
        throw Error("Scan file integrity check failed");
      return { name: f.name, data };
    }),
  );
  return { ...a, files };
}

export function resolveLocalResource(url: string, assets: Map<string, string>) {
  const name = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "");
  const local = assets.get(name);
  if (local) return local;
  if (url.startsWith("blob:") || /^data:(application|image|model)\//.test(url))
    return url;
  throw Error("Missing local scan file; external resources are not loaded");
}
