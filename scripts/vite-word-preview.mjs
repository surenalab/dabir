// Browser preview only (`npm run dev`, never in a build): Word documents for the preview's sample Word paper.
//
//   GET  /__dabir/word?name=manuscript.docx   the document's bytes. With DABIR_SAMPLE_DOCX_DIR set, a file of that
//                                            name in that folder; otherwise manuscript.docx is the filled-in
//                                            sample from scripts/word-template.mjs, generated on first request.
//   POST /__dabir/word-saved?name=…           what the preview's autosave wrote, kept under the system temp folder
//                                            (dabir-word-preview/) so a round trip can be checked with pandoc.
//
// Names are reduced to their last path component, so nothing outside those two folders is read or written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const MAX_BYTES = 64 * 1024 * 1024;
export const SAVED_DIR = join(tmpdir(), "dabir-word-preview");

function nameOf(url) {
  const raw = new URL(url, "http://localhost").searchParams.get("name") ?? "manuscript.docx";
  const name = basename(raw.replace(/\\/g, "/"));
  return /\.docx$/i.test(name) && !name.startsWith(".") ? name : null;
}

/** A request from the preview itself: a page on another site cannot post here (no CORS answer, and this check). */
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

export function wordPreview() {
  let sample = null;
  return {
    name: "dabir-word-preview",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dabir/word-saved", (req, res) => {
        const name = nameOf(req.url ?? "");
        if (req.method !== "POST" || !name || !sameOrigin(req) || req.headers["content-type"] !== "application/octet-stream") { res.statusCode = 400; res.end(); return; }
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); });
        req.on("end", () => {
          if (size > MAX_BYTES) { res.statusCode = 413; res.end(); return; }
          mkdirSync(SAVED_DIR, { recursive: true });
          writeFileSync(join(SAVED_DIR, name), Buffer.concat(chunks));
          res.statusCode = 204; res.end();
        });
      });
      server.middlewares.use("/__dabir/word", async (req, res) => {
        const name = nameOf(req.url ?? "");
        const send = (bytes) => { res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); res.setHeader("Cache-Control", "no-store"); res.end(bytes); };
        const missing = () => { res.statusCode = 404; res.end(); };
        if (!name) return missing();
        const dir = process.env.DABIR_SAMPLE_DOCX_DIR;
        if (dir && existsSync(join(dir, name))) return send(readFileSync(join(dir, name)));
        if (name !== "manuscript.docx") return missing();
        try {
          if (!sample) sample = await (await import("./word-template.mjs")).manuscript({ sample: true });
          send(sample);
        } catch (e) { server.config.logger.error(`word preview: ${e}`); res.statusCode = 500; res.end(); }
      });
    },
  };
}
