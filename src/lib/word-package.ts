// A Word document as a zip package: what the Word view does to one on its way in and out. Kept apart from word.ts
// (pure text) because it needs JSZip; scripts/word-template.mjs uses it too, so it stays erasable TypeScript.
import JSZip from "jszip";
import { addParagraphIds, lacksParagraphIds, paragraphIdMaker, paragraphIdsIn, repairCoreProperties } from "./word.ts";

/** The parts whose paragraphs Word numbers. */
const PARAGRAPH_PARTS = /^word\/(document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/;

/** The document with a `w14:paraId` on every paragraph (see addParagraphIds). The same bytes come back when there is
 *  nothing to add, which is the case for anything Word saved. */
export async function withParagraphIds(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => PARAGRAPH_PARTS.test(n)).sort();
  const texts = await Promise.all(names.map((n) => zip.file(n)!.async("string")));
  if (!texts.some(lacksParagraphIds)) return bytes;
  const next = paragraphIdMaker(new Set(texts.flatMap(paragraphIdsIn)));
  names.forEach((name, i) => {
    const out = addParagraphIds(texts[i], next);
    if (out !== texts[i]) zip.file(name, out);
  });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** The package as saved, with the one defect the engine is known to write put right (see repairCoreProperties).
 *  Rebuilt only when there is something to repair. */
export async function repaired(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const core = zip.file("docProps/core.xml");
  if (!core) return bytes;
  const xml = await core.async("string");
  const fixed = repairCoreProperties(xml);
  if (fixed === xml) return bytes;
  zip.file("docProps/core.xml", fixed);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
