// Word documents (src/lib/word.ts): the pure helpers the Word view and the app shell share. The module has only
// erasable TypeScript, which Node 22.18 and later run directly, so the test imports the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, isWordPath, latexFolderFor, looksLikeDocx, markupWidth, pagePixels, parentFolder, stepWordZoom, wordContextPath, wordOutline, wordScale, wordStem, zoomLabel, WORD_MODES, WORD_ZOOM_MAX, WORD_ZOOM_MIN } from "../src/lib/word.ts";

const a4 = pagePixels(11906, 16838);

test("a Word document is a .docx that is not Word's lock file", () => {
  assert.equal(isWordPath("/papers/buffer/manuscript.docx"), true);
  assert.equal(isWordPath("C:\\papers\\Draft.DOCX"), true);
  assert.equal(isWordPath("/papers/buffer/~$manuscript.docx"), false);
  assert.equal(isWordPath("/papers/buffer/manuscript.doc"), false);
  assert.equal(isWordPath("/papers/docx/main.tex"), false);
  assert.equal(isWordPath(null), false);
});

test("only a zip package may replace a Word document", () => {
  const zip = new Uint8Array(30); zip.set([0x50, 0x4b, 0x03, 0x04]);
  assert.equal(looksLikeDocx(zip), true);
  assert.equal(looksLikeDocx(new TextEncoder().encode("<html><body>not a document</body></html>")), false);
  assert.equal(looksLikeDocx(zip.slice(0, 10)), false, "too short to be a package");
  assert.equal(looksLikeDocx(new Uint8Array()), false);
  assert.equal(looksLikeDocx(null), false);
});

test("page size comes from the section in twips, A4 when it is missing", () => {
  assert.deepEqual(a4, { w: 11906 / 15, h: 16838 / 15 });
  assert.equal(Math.round(pagePixels(12240, 15840).w), 816, "US Letter");
  assert.deepEqual(pagePixels(undefined, 0), { w: 793.7, h: 1122.5 });
});

test("fit width and whole page follow the pane; a fixed zoom is clamped", () => {
  const pane = { w: 828, h: 716 };
  const fit = wordScale("fit", a4, pane);
  assert.ok(fit * a4.w + 64 <= pane.w, "the page and its padding fit across");
  assert.ok(fit > 0.95 && fit < 1, `fit width ${fit}`);
  const page = wordScale("page", a4, pane);
  assert.ok(page * a4.h + 64 <= pane.h && page < fit, `whole page ${page}`);
  assert.equal(wordScale("fit", a4, { w: 4000, h: 900 }), 2, "fit width stops at 200 %");
  assert.equal(wordScale("fit", a4, { w: 0, h: 0 }), 1, "a pane not laid out yet");
  assert.equal(wordScale(9, a4, pane), WORD_ZOOM_MAX);
  assert.equal(wordScale(0.01, a4, pane), WORD_ZOOM_MIN);
  assert.equal(wordScale(1.25, a4, pane), 1.25);
});

test("zoom steps are symmetric and bounded, and the label names the mode", () => {
  assert.equal(stepWordZoom(1, 1), 1.18);
  assert.equal(stepWordZoom(stepWordZoom(1, 1), -1), 1);
  assert.equal(stepWordZoom(WORD_ZOOM_MAX, 1), WORD_ZOOM_MAX);
  assert.equal(stepWordZoom(WORD_ZOOM_MIN, -1), WORD_ZOOM_MIN);
  assert.equal(zoomLabel("fit", 0.98), "Fit width · 98 %");
  assert.equal(zoomLabel("page", 0.6), "Whole page · 60 %");
  assert.equal(zoomLabel(1.5, 1.5), "150 %");
});

test("the comment column needs the page at full size beside it", () => {
  assert.equal(markupWidth(a4.w), 794 + 48 + 340 + 4);
  assert.ok(markupWidth(a4.w) > 828, "the three-pane layout on a 1440 px screen is too narrow for it");
});

test("words are counted as Word counts them", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("Willow buffers remove 58 % of nitrate."), 6);
  assert.equal(countWords("well-known riparian buffers don't fail"), 5, "hyphenated words and contractions count once");
  assert.equal(countWords("Größe und Überlauf — 25 m"), 5, "letters beyond ASCII and numbers are words; a dash is not");
  assert.equal(countWords("  \n\t "), 0);
});

test("the outline keeps headings 1 to 3, numbered by position so a click finds the heading again", () => {
  const rows = wordOutline([
    { text: "Introduction", level: 0, pmPos: 10 },
    { text: "  Sites \n and sampling ", level: 1, pmPos: 40 },
    { text: "", level: 0, pmPos: 60 },
    { text: "Deep detail", level: 3, pmPos: 80 },
    { text: "Analysis", level: 2, pmPos: 90 },
  ]);
  assert.deepEqual(rows, [
    { level: 1, number: "", text: "Introduction", line: 1, hint: "Heading 1" },
    { level: 2, number: "", text: "Sites and sampling", line: 2, hint: "Heading 2" },
    { level: 3, number: "", text: "Analysis", line: 5, hint: "Heading 3" },
  ]);
});

test("names and folders", () => {
  // Keep in step with word::context_rel in src-tauri/src/word.rs.
  assert.equal(wordContextPath("manuscript.docx"), ".dabir/context/manuscript.md");
  assert.equal(wordContextPath("drafts\\v2 final.DOCX"), ".dabir/context/drafts__v2 final.md");
  assert.equal(wordStem("/a/Draft from Maryam.docx"), "Draft from Maryam");
  assert.equal(latexFolderFor("/a/Draft from Maryam.docx"), "draft-from-maryam-latex");
  assert.equal(latexFolderFor("/a/مقاله.docx"), "word-paper-latex");
  assert.equal(parentFolder("/Users/ada/Papers/buffer/manuscript.docx"), "/Users/ada/Papers/buffer");
  assert.equal(parentFolder("C:\\Papers\\buffer\\m.docx"), "C:\\Papers\\buffer");
});

test("the editing modes are Editing, Suggesting and Viewing, in that order", () => {
  assert.deepEqual(WORD_MODES.map((m) => m.value), ["editing", "suggesting", "viewing"]);
});

test("core properties get the namespaces they use", async () => {
  const { repairCoreProperties } = await import("../src/lib/word.ts");
  // What the engine writes for a file whose core.xml declared only cp and dc.
  const broken = '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>A</dc:creator><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-17T15:36:55Z</dcterms:modified></cp:coreProperties>';
  const fixed = repairCoreProperties(broken);
  assert.match(fixed, /<cp:coreProperties [^>]*xmlns:dcterms="http:\/\/purl.org\/dc\/terms\/"/);
  assert.match(fixed, /<cp:coreProperties [^>]*xmlns:xsi="http:\/\/www.w3.org\/2001\/XMLSchema-instance"/);
  assert.equal((fixed.match(/xmlns:dc=/g) ?? []).length, 1, "declared ones are not repeated");
  assert.ok(fixed.endsWith("<dc:creator>A</dc:creator><dcterms:modified xsi:type=\"dcterms:W3CDTF\">2026-09-17T15:36:55Z</dcterms:modified></cp:coreProperties>"));
  // A well-formed part, or something else entirely, comes back unchanged.
  assert.equal(repairCoreProperties(fixed), fixed);
  assert.equal(repairCoreProperties("<other/>"), "<other/>");
});

test("every paragraph gets an id Word would give it, and nothing else changes", async () => {
  const { addParagraphIds, lacksParagraphIds, paragraphIdMaker, paragraphIdsIn } = await import("../src/lib/word.ts");
  const doc = '<w:document xmlns:w="w" mc:Ignorable="w15" xmlns:mc="mc"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>T</w:t></w:r></w:p><w:p w14:paraId="10000001" w14:textId="1"/><w:p/><w:tbl><w:tr><w:tc><w:p w:rsidR="00A1"><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  assert.equal(lacksParagraphIds(doc), true);
  const taken = new Set(paragraphIdsIn(doc));
  assert.deepEqual([...taken], ["10000001"]);
  const out = addParagraphIds(doc, paragraphIdMaker(taken));
  assert.equal(lacksParagraphIds(out), false);
  const ids = paragraphIdsIn(out);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, "ids are unique and skip the one already there");
  assert.ok(ids.every((id) => /^[0-9A-F]{8}$/.test(id) && parseInt(id, 16) < 0x80000000));
  assert.match(out, /<w:document xmlns:w="w" mc:Ignorable="w15 w14" xmlns:mc="mc" xmlns:w14="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordml">/);
  assert.match(out, /<w:p w14:paraId="[0-9A-F]{8}" w14:textId="77777777"\/>/, "an empty paragraph keeps its self-closing tag");
  assert.match(out, /<w:p w14:paraId="[0-9A-F]{8}" w14:textId="77777777" w:rsidR="00A1">/);
  assert.ok(out.includes("<w:pPr><w:pStyle w:val=\"Title\"/></w:pPr>"), "paragraph properties are not taken for paragraphs");
  assert.equal(addParagraphIds(out, () => "X"), out, "a numbered part is left alone");
  const bare = addParagraphIds('<w:ftr xmlns:w="w"><w:p/></w:ftr>', paragraphIdMaker(new Set()));
  assert.match(bare, /^<w:ftr xmlns:w="w" xmlns:w14="[^"]+" xmlns:mc="[^"]+" mc:Ignorable="w14">/);
});

test("a package without paragraph ids is numbered once, a numbered one is returned as it is", async () => {
  const JSZip = (await import("jszip")).default;
  const { withParagraphIds } = await import("../src/lib/word-package.ts");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/styles.xml", "<w:styles/>");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const once = await withParagraphIds(bytes);
  assert.notEqual(once, bytes);
  const read = await JSZip.loadAsync(once);
  assert.match(await read.file("word/document.xml").async("string"), /<w:p w14:paraId="10000000"/);
  assert.equal(await read.file("word/styles.xml").async("string"), "<w:styles/>");
  assert.equal(await withParagraphIds(once), once, "nothing to add: the same bytes");
});

// Office 365 writes the main part as word/document2.xml (import.rs and word.rs both read the package
// relationships for that reason). The ids must reach it: without them the engine's selective save bails
// out and repacks the document whole, which drops the comments part and the fields that span paragraphs.
test("the main part is numbered whatever Office called it", async () => {
  const JSZip = (await import("jszip")).default;
  const { withParagraphIds } = await import("../src/lib/word-package.ts");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("_rels/.rels", '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document2.xml"/></Relationships>');
  zip.file("word/document2.xml", '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
  const read = await JSZip.loadAsync(await withParagraphIds(await zip.generateAsync({ type: "uint8array" })));
  assert.match(await read.file("word/document2.xml").async("string"), /<w:p w14:paraId="[0-9A-F]{8}"/);
});
