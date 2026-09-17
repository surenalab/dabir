// The Word manuscript behind File › New Word Document and the Word template in New Paper, built with the
// `docx` package (MIT) so its styles are written down here rather than hidden in a binary.
//
//   node scripts/word-template.mjs            writes templates/word-manuscript/manuscript.docx
//   node scripts/word-template.mjs --sample   writes a filled-in paper to stdout (the browser preview's sample)
//
// The blank manuscript carries Word's own style ids (Title, Heading1–3, Caption, Bibliography) so every
// word processor, pandoc and Dabir's outline recognise them, plus Author, Affiliation, Abstract and Keywords.
// The sample variant (`manuscript({ sample: true })`) is what `npm run dev` serves for `?open=sample-word`;
// it is generated on request and never bundled.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, DeletedTextRun, Document, Footer,
  FootnoteReferenceRun, HeadingLevel, InsertedTextRun, LineRuleType, Packer, PageNumber, Paragraph, Table, TableCell,
  TableRow, TextRun, WidthType,
} from "docx";
// Word numbers every paragraph (w14:paraId) and the `docx` package does not; the Word view's own helper adds them.
import { withParagraphIds } from "../src/lib/word-package.ts";

const FONT = "Times New Roman";
const pt = (n) => n * 2; // docx sizes are half-points
const twip = (n) => n * 20; // spacing is in twentieths of a point

const styles = {
  default: {
    document: {
      run: { font: FONT, size: pt(12), language: { value: "en-GB" } },
      paragraph: { spacing: { line: 360, lineRule: LineRuleType.AUTO, after: twip(6) } },
    },
    title: { run: { font: FONT, size: pt(20), bold: true, color: "000000" }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 0, after: twip(12), line: 276 } } },
    heading1: { run: { font: FONT, size: pt(14), bold: true, color: "000000" }, paragraph: { spacing: { before: twip(18), after: twip(6), line: 276 }, keepNext: true, keepLines: true, outlineLevel: 0 } },
    heading2: { run: { font: FONT, size: pt(12), bold: true, color: "000000" }, paragraph: { spacing: { before: twip(12), after: twip(4), line: 276 }, keepNext: true, keepLines: true, outlineLevel: 1 } },
    heading3: { run: { font: FONT, size: pt(12), bold: true, italics: true, color: "000000" }, paragraph: { spacing: { before: twip(10), after: twip(2), line: 276 }, keepNext: true, keepLines: true, outlineLevel: 2 } },
    footnoteText: { run: { font: FONT, size: pt(10) }, paragraph: { spacing: { after: 0, line: 240 } } },
  },
  // Normal is written out, not left to the document defaults: readers such as pandoc resolve the headings'
  // `basedOn` chain through it and do not see headings otherwise.
  paragraphStyles: [
    { id: "Normal", name: "Normal", quickFormat: true, run: { font: FONT, size: pt(12) }, paragraph: { spacing: { line: 360, lineRule: LineRuleType.AUTO, after: twip(6) } } },
    { id: "Author", name: "Author", basedOn: "Normal", next: "Affiliation", quickFormat: true, run: { size: pt(12) }, paragraph: { alignment: AlignmentType.CENTER, spacing: { after: twip(2), line: 276 } } },
    { id: "Affiliation", name: "Affiliation", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: pt(10), italics: true }, paragraph: { alignment: AlignmentType.CENTER, spacing: { after: twip(2), line: 240 } } },
    { id: "AbstractTitle", name: "Abstract Title", basedOn: "Normal", next: "Abstract", quickFormat: true, run: { bold: true, smallCaps: true, size: pt(11) }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: twip(18), after: twip(4) }, keepNext: true } },
    { id: "Abstract", name: "Abstract", basedOn: "Normal", next: "Keywords", quickFormat: true, run: { size: pt(11) }, paragraph: { alignment: AlignmentType.JUSTIFIED, indent: { left: 567, right: 567 }, spacing: { after: twip(6), line: 300 } } },
    { id: "Keywords", name: "Keywords", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: pt(11) }, paragraph: { indent: { left: 567, right: 567 }, spacing: { after: twip(18), line: 300 } } },
    { id: "Caption", name: "caption", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: pt(10) }, paragraph: { spacing: { before: twip(4), after: twip(12), line: 240 } } },
    { id: "Bibliography", name: "Bibliography", basedOn: "Normal", next: "Bibliography", quickFormat: true, run: { size: pt(11) }, paragraph: { indent: { left: 567, hanging: 567 }, spacing: { after: twip(4), line: 276 } } },
    { id: "TableText", name: "Table Text", basedOn: "Normal", quickFormat: true, run: { size: pt(10) }, paragraph: { spacing: { before: twip(2), after: twip(2), line: 240 } } },
  ],
};

const footer = () => new Footer({
  children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: pt(10) })] })],
});

const p = (text, style) => new Paragraph({ style, children: [new TextRun(text)] });
const h = (text, heading) => new Paragraph({ heading, children: [new TextRun(text)] });

function blank() {
  return {
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Title of the paper")] }),
      p("First Author¹, Second Author²", "Author"),
      p("¹ Department, Institution, City, Country", "Affiliation"),
      p("² Department, Institution, City, Country", "Affiliation"),
      p("Corresponding author: name@institution.org", "Affiliation"),
      p("Abstract", "AbstractTitle"),
      p("State the question, what you did, what you found and why it matters, in 150 to 250 words.", "Abstract"),
      new Paragraph({ style: "Keywords", children: [new TextRun({ text: "Keywords: ", bold: true }), new TextRun("first; second; third")] }),
      h("Introduction", HeadingLevel.HEADING_1),
      p("What is known, what is not, and the question this paper answers."),
      h("Materials and methods", HeadingLevel.HEADING_1),
      h("Study design", HeadingLevel.HEADING_2),
      p("How the work was done, in enough detail to repeat it."),
      h("Statistical analysis", HeadingLevel.HEADING_3),
      p("Tests, software and thresholds."),
      h("Results", HeadingLevel.HEADING_1),
      p("What was found, in the order of the questions."),
      p("Figure 1. A caption says what the figure shows and what to notice.", "Caption"),
      h("Discussion", HeadingLevel.HEADING_1),
      p("What the results mean, their limits, and what follows."),
      h("Acknowledgements", HeadingLevel.HEADING_1),
      p("Funding and help."),
      h("References", HeadingLevel.HEADING_1),
      p("Author A, Author B. Title of the article. Journal. Year;Volume(Issue):Pages. doi:10.0000/example", "Bibliography"),
    ],
  };
}

function sample() {
  const who = { author: "Maryam Karimi", date: "2026-09-10T09:30:00Z" };
  const cell = (text, bold = false) => new TableCell({
    width: { size: 25, type: WidthType.PERCENTAGE },
    children: [new Paragraph({ style: "TableText", children: [new TextRun({ text, bold })] })],
  });
  const rule = { style: BorderStyle.SINGLE, size: 6, color: "000000" };
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: rule, bottom: rule, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows: [
      new TableRow({ tableHeader: true, children: [cell("Buffer", true), cell("Width (m)", true), cell("Nitrate in (mg/L)", true), cell("Removal (%)", true)] }),
      new TableRow({ children: [cell("Grass"), cell("10"), cell("8.4"), cell("31")] }),
      new TableRow({ children: [cell("Willow"), cell("10"), cell("8.1"), cell("58")] }),
      new TableRow({ children: [cell("Mixed woodland"), cell("25"), cell("7.9"), cell("74")] }),
    ],
  });
  return {
    comments: { children: [{ id: 0, author: "Maryam Karimi", initials: "MK", date: new Date("2026-09-11T14:02:00Z"), children: [new Paragraph("Should we give the confidence interval here as well?")] }] },
    footnotes: { 1: { children: [new Paragraph("Sites were sampled after at least three dry days, so flow was at base level.")] } },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Willow buffers remove more nitrate than grass strips in lowland streams")] }),
      p("Ada Lindqvist¹, Maryam Karimi², Tomás Ferreira¹", "Author"),
      p("¹ School of Biological Sciences, University of Northfield, UK", "Affiliation"),
      p("² Centre for Catchment Hydrology, Lakeside Institute, UK", "Affiliation"),
      p("Abstract", "AbstractTitle"),
      new Paragraph({ style: "Abstract", children: [
        new TextRun("Riparian buffers are the most common measure against agricultural nitrate, yet their planting is chosen by habit rather than evidence. We sampled 42 buffers on nine lowland streams over two years and compared nitrate at the field edge with nitrate at the bank. "),
        new CommentRangeStart(0),
        new TextRun("Willow buffers removed 58 % of incoming nitrate against 31 % for grass strips of the same width"),
        new CommentRangeEnd(0),
        new TextRun({ children: [new CommentReference(0)] }),
        new TextRun(", and mixed woodland 74 % at 25 m. "),
        new InsertedTextRun({ text: "The difference held in both wet and dry years. ", id: 1, ...who }),
        new TextRun("Planting guidance should favour woody species where a buffer "),
        new DeletedTextRun({ text: "can be", id: 2, ...who }),
        new InsertedTextRun({ text: "is", id: 3, ...who }),
        new TextRun(" wider than 10 m."),
      ] }),
      new Paragraph({ style: "Keywords", children: [new TextRun({ text: "Keywords: ", bold: true }), new TextRun("nitrate; riparian buffer; willow; catchment management")] }),
      h("Introduction", HeadingLevel.HEADING_1),
      p("Nitrate leaching from arable land is the main cause of nutrient enrichment in lowland streams. Buffer strips between field and bank intercept shallow groundwater, where plant uptake and denitrification remove part of the load. How much depends on width, soil and, less clearly, on what is planted."),
      p("Most schemes pay for grass because it is cheap to establish. Whether woody planting is worth the extra cost has been argued from single sites; we asked the question across a catchment."),
      h("Materials and methods", HeadingLevel.HEADING_1),
      h("Sites and sampling", HeadingLevel.HEADING_2),
      new Paragraph({ children: [
        new TextRun("We chose 42 buffers on nine streams, each paired with an unbuffered reach upstream. Piezometers at the field edge and at the bank were sampled monthly"),
        new FootnoteReferenceRun(1),
        new TextRun(" from March 2024 to February 2026."),
      ] }),
      h("Laboratory analysis", HeadingLevel.HEADING_3),
      p("Nitrate was measured by ion chromatography (detection limit 0.05 mg/L). Removal is one minus the ratio of bank to field-edge concentration."),
      h("Results", HeadingLevel.HEADING_1),
      p("Removal rose with width for every planting, and woody buffers removed more at every width (Table 1)."),
      p("Table 1. Mean nitrate removal by buffer type, both years pooled.", "Caption"),
      table,
      p("The ranking did not change between the wet first year and the dry second year."),
      h("Discussion", HeadingLevel.HEADING_1),
      p("Willow roots reach the water table in the first season, which may explain why the gap opens early. Grass strips saturate in winter, when most nitrate moves."),
      h("References", HeadingLevel.HEADING_1),
      p("Hill AR. Nitrate removal in stream riparian zones. Journal of Environmental Quality. 1996;25(4):743-755.", "Bibliography"),
      p("Mayer PM, Reynolds SK, McCutchen MD, Canfield TJ. Meta-analysis of nitrogen removal in riparian buffers. Journal of Environmental Quality. 2007;36(4):1172-1180.", "Bibliography"),
    ],
  };
}

/** The manuscript as .docx bytes; `sample` fills it with a short paper carrying a comment, a footnote and tracked changes. */
export async function manuscript({ sample: filled = false } = {}) {
  const body = filled ? sample() : blank();
  const doc = new Document({
    creator: "Dabir",
    title: filled ? "Willow buffers remove more nitrate than grass strips" : "Title of the paper",
    description: "Academic manuscript template from Dabir",
    styles,
    comments: body.comments,
    footnotes: body.footnotes,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      footers: { default: footer() },
      children: body.children,
    }],
  });
  return Buffer.from(await withParagraphIds(await Packer.toBuffer(doc)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bytes = await manuscript({ sample: process.argv.includes("--sample") });
  if (process.argv.includes("--sample")) process.stdout.write(bytes);
  else {
    const out = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "word-manuscript", "manuscript.docx");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    console.log(`wrote ${out} (${bytes.length} bytes)`);
  }
}
