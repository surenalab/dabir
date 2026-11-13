#!/usr/bin/env python3
"""Check every entry of one or more BibTeX files against the public scholarly indexes.

Standard library only; needs Python 3.8+ and network access. For each entry the verdict is one of

  verified   a record with the same title was found at the entry's DOI or arXiv id, or by title search
  mismatch   the entry's DOI or arXiv id resolves to a different work, or does not resolve at all
  not found  no index has a work with this title; possibly a thesis, software, or an invented reference
  unchecked  nothing to look up (no title) or the network failed for this entry

Usage:
  verify_refs.py refs.bib [more.bib ...] [--json] [--only key1,key2] [--offline] [--workers N]

Exit status is 0 when nothing is mismatched or missing, 1 otherwise, 2 on usage errors.
"""
import concurrent.futures
import difflib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "dabir-check-references/1 (+https://github.com/surenalab/dabir)"
TIMEOUT = 25
MATCH = 0.90     # title similarity that counts as the same work
CLOSE = 0.75     # below this a search hit is not even reported as a candidate


# ------------------------------------------------------------------ BibTeX

def parse_bib(text):
    """Yield (type, key, fields) for each entry; brace- and quote-aware, comments and @string skipped."""
    i, n = 0, len(text)
    while True:
        i = text.find("@", i)
        if i < 0:
            return
        m = re.match(r"@\s*(\w+)\s*([{(])", text[i:])
        if not m:
            i += 1
            continue
        kind, open_ch = m.group(1).lower(), m.group(2)
        close_ch = "}" if open_ch == "{" else ")"
        j = i + m.end()
        depth, k = 1, j
        while k < n and depth:
            c = text[k]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == close_ch == ")" and depth == 1:
                depth = 0
                break
            k += 1
        body = text[j:k]
        i = k + 1
        if kind in ("comment", "preamble", "string"):
            continue
        comma = body.find(",")
        if comma < 0:
            continue
        key = body[:comma].strip()
        yield kind, key, parse_fields(body[comma + 1:])


def parse_fields(s):
    fields, i, n = {}, 0, len(s)
    while i < n:
        m = re.match(r"\s*(\w[\w\-:.]*)\s*=\s*", s[i:])
        if not m:
            break
        name = m.group(1).lower()
        i += m.end()
        if i >= n:
            break
        if s[i] == "{":
            depth, j = 0, i
            while j < n:
                if s[j] == "{":
                    depth += 1
                elif s[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            val = s[i + 1:j]
            i = j + 1
        elif s[i] == '"':
            j = i + 1
            while j < n and (s[j] != '"' or s[j - 1] == "\\"):
                j += 1
            val = s[i + 1:j]
            i = j + 1
        else:
            m2 = re.match(r"[^,]*", s[i:])
            val = m2.group(0).strip()
            i += m2.end()
        fields[name] = " ".join(val.split())
        m3 = re.match(r"\s*,?", s[i:])
        i += m3.end()
    return fields


def detex(s):
    """Strip TeX from a field value for comparison: braces, accents, commands, math."""
    s = re.sub(r"\\[a-zA-Z]+\s*", " ", s)
    s = re.sub(r"[{}$\\'`\"^~]", "", s)
    s = s.replace("--", "-")
    return " ".join(s.split())


def norm_title(s):
    s = detex(s).lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return " ".join(s.split())


def similarity(a, b):
    a, b = norm_title(a), norm_title(b)
    if not a or not b:
        return 0.0
    if a == b or a.startswith(b) or b.startswith(a):
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def surnames(author_field):
    out = []
    for part in re.split(r"\s+and\s+", detex(author_field)):
        part = part.strip()
        if not part or part.lower() == "others":
            continue
        if "," in part:
            out.append(part.split(",")[0].strip().lower())
        else:
            out.append(part.split()[-1].lower())
    return out


def find_doi(f):
    doi = f.get("doi", "")
    if not doi:
        for v in (f.get("url", ""), f.get("note", ""), f.get("howpublished", "")):
            m = re.search(r"10\.\d{4,9}/[^\s\"'<>{}]+", v)
            if m:
                doi = m.group(0)
                break
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", doi.strip(), flags=re.I)
    return doi.rstrip(".,;") or None


ARXIV_ID = r"(\d{4}\.\d{4,5}(v\d+)?|[a-z\-]+(\.[A-Z]{2})?/\d{7})"


def find_arxiv(f):
    for v in (f.get("eprint", ""), f.get("arxivid", ""), f.get("url", ""), f.get("journal", ""), f.get("note", ""), f.get("howpublished", ""), f.get("volume", "")):
        m = re.search(r"(arxiv\.org/(abs|pdf)/|arXiv:\s*)" + ARXIV_ID, v, flags=re.I)
        if m:
            return re.sub(r"v\d+$", "", m.group(3))
        if v == f.get("eprint", "") and re.fullmatch(ARXIV_ID, v.strip()):
            return re.sub(r"v\d+$", "", v.strip())
    return None


# ------------------------------------------------------------------ HTTP

def get(url, accept=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept or "application/json"})
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return e.code, b""
            last = e
            if e.code == 429 or e.code >= 500:
                time.sleep(1.5 * (attempt + 1))
                continue
            return e.code, b""
        except Exception as e:  # network, timeout, TLS
            last = e
            time.sleep(0.8)
    raise RuntimeError(str(last))


def crossref_record(msg):
    year = None
    for k in ("published-print", "published-online", "issued", "created"):
        parts = msg.get(k, {}).get("date-parts")
        if parts and parts[0] and parts[0][0]:
            year = parts[0][0]
            break
    return {
        "title": (msg.get("title") or [""])[0],
        "year": year,
        "venue": (msg.get("container-title") or msg.get("event", {}).get("name") and [msg["event"]["name"]] or [""])[0],
        "volume": msg.get("volume"),
        "number": msg.get("issue"),
        "pages": msg.get("page"),
        "doi": msg.get("DOI"),
        "authors": [a.get("family", "").lower() for a in msg.get("author", []) if a.get("family")],
        "type": msg.get("type"),
    }


def by_doi(doi):
    status, body = get("https://api.crossref.org/works/" + urllib.parse.quote(doi, safe=""))
    if status == 200:
        return crossref_record(json.loads(body)["message"]), "crossref"
    # DataCite and other agencies: content negotiation at doi.org.
    status, body = get("https://doi.org/" + urllib.parse.quote(doi, safe="/"), accept="application/vnd.citationstyles.csl+json")
    if status == 200 and body:
        m = json.loads(body)
        issued = m.get("issued", {}).get("date-parts", [[None]])
        return {
            "title": m.get("title", ""),
            "year": issued[0][0] if issued and issued[0] else None,
            "venue": m.get("container-title", ""),
            "volume": m.get("volume"),
            "number": m.get("issue"),
            "pages": m.get("page"),
            "doi": m.get("DOI", doi),
            "authors": [a.get("family", "").lower() for a in m.get("author", []) if a.get("family")],
            "type": m.get("type"),
        }, "doi.org"
    return None, None


def by_arxiv(aid):
    status, body = get("https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(aid), accept="application/atom+xml")
    if status != 200:
        return None
    ns = {"a": "http://www.w3.org/2005/Atom", "x": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(body)
    entry = root.find("a:entry", ns)
    if entry is None or entry.find("a:title", ns) is None:
        return None
    title = " ".join((entry.findtext("a:title", "", ns) or "").split())
    if title.lower().startswith("error"):
        return None
    published = entry.findtext("a:published", "", ns)
    doi_el = entry.find("x:doi", ns)
    return {
        "title": title,
        "year": int(published[:4]) if published[:4].isdigit() else None,
        "venue": "arXiv",
        "volume": None, "number": None, "pages": None,
        "doi": doi_el.text.strip() if doi_el is not None and doi_el.text else None,
        "authors": [(a.findtext("a:name", "", ns) or "").split()[-1].lower() for a in entry.findall("a:author", ns)],
        "type": "preprint",
        "arxiv": aid,
    }


def search_crossref(title, author, year):
    q = urllib.parse.urlencode({
        "query.bibliographic": " ".join(x for x in (detex(title), author or "", str(year or "")) if x),
        "rows": 3,
        "select": "DOI,title,issued,published-print,published-online,container-title,author,volume,issue,page,type,event",
    })
    status, body = get("https://api.crossref.org/works?" + q)
    if status != 200:
        return []
    return [crossref_record(m) for m in json.loads(body)["message"].get("items", [])]


def search_openalex(title):
    q = urllib.parse.urlencode({"search": detex(title), "per-page": 3})
    status, body = get("https://api.openalex.org/works?" + q)
    if status != 200:
        return []
    out = []
    for w in json.loads(body).get("results", []):
        loc = (w.get("primary_location") or {}).get("source") or {}
        b = w.get("biblio") or {}
        pages = "-".join(p for p in (b.get("first_page"), b.get("last_page")) if p) or None
        out.append({
            "title": w.get("display_name") or w.get("title") or "",
            "year": w.get("publication_year"),
            "venue": loc.get("display_name", ""),
            "volume": b.get("volume"), "number": b.get("issue"), "pages": pages,
            "doi": (w.get("doi") or "").replace("https://doi.org/", "") or None,
            "authors": [((a.get("author") or {}).get("display_name") or "").split()[-1].lower() for a in w.get("authorships", []) if (a.get("author") or {}).get("display_name")],
            "type": w.get("type"),
        })
    return out


# ------------------------------------------------------------------ verdicts

def year_of(f):
    m = re.search(r"\d{4}", f.get("year", "") or f.get("date", ""))
    return int(m.group(0)) if m else None


def differences(f, rec):
    """Fields where the entry and the record disagree, as short strings."""
    notes = []
    y = year_of(f)
    if y and rec.get("year") and abs(y - rec["year"]) > 1:
        notes.append("year %s vs %s" % (y, rec["year"]))
    elif y and rec.get("year") and y != rec["year"]:
        notes.append("year %s vs %s (online-first?)" % (y, rec["year"]))
    venue = f.get("journal") or f.get("booktitle") or ""
    if venue and rec.get("venue") and rec["venue"] != "arXiv":
        a, b = norm_title(venue), norm_title(rec["venue"])
        if a and b and a not in b and b not in a and difflib.SequenceMatcher(None, a, b).ratio() < 0.6:
            notes.append("venue '%s' vs '%s'" % (detex(venue), rec["venue"]))
    for k in ("volume", "number", "pages"):
        mine = (f.get(k) or "").replace("--", "-").replace("–", "-").strip()
        theirs = (rec.get(k) or "").replace("--", "-").replace("–", "-").strip()
        if mine and theirs and mine != theirs:
            notes.append("%s %s vs %s" % (k, mine, theirs))
    if rec.get("authors") and f.get("author"):
        mine = surnames(f["author"])
        theirs = set(rec["authors"])
        missing = [s for s in mine if s not in theirs and not any(s in t or t in s for t in theirs)]
        if missing:
            notes.append("authors not in record: " + ", ".join(missing))
    mine_doi = (find_doi(f) or "").lower()
    if rec.get("doi") and not mine_doi:
        notes.append("add doi = {%s}" % rec["doi"])
    return notes


def check(kind, key, f, offline=False):
    r = {"key": key, "type": kind, "title": detex(f.get("title", "")), "status": "unchecked", "via": None, "doi": None, "notes": []}
    title = f.get("title", "")
    doi = find_doi(f)
    aid = find_arxiv(f)
    if offline:
        r["notes"].append("offline")
        return r
    if not title and not doi and not aid:
        r["notes"].append("no title, DOI or arXiv id to check")
        return r
    try:
        if doi:
            rec, via = by_doi(doi)
            if rec is None:
                r.update(status="mismatch", via="doi", doi=doi, notes=["DOI %s does not resolve" % doi])
                return r
            r["doi"] = rec.get("doi") or doi
            r["via"] = via
            if not title:
                r.update(status="verified", notes=["no title in entry; DOI resolves to '%s'" % rec["title"]])
                return r
            s = similarity(title, rec["title"])
            if s >= MATCH:
                r.update(status="verified", notes=differences(f, rec))
            else:
                r.update(status="mismatch", notes=["DOI resolves to '%s' (%d%% similar)" % (rec["title"], round(s * 100))])
            return r
        if aid:
            rec = by_arxiv(aid)
            if rec is None:
                r.update(status="mismatch", via="arxiv", notes=["arXiv id %s does not resolve" % aid])
                return r
            r["via"] = "arxiv"
            r["doi"] = rec.get("doi")
            s = similarity(title, rec["title"]) if title else 1.0
            if s >= MATCH:
                notes = differences(f, rec)
                if rec.get("doi"):
                    notes.append("published version has DOI %s" % rec["doi"])
                r.update(status="verified", notes=notes)
            else:
                r.update(status="mismatch", notes=["arXiv %s is '%s' (%d%% similar)" % (aid, rec["title"], round(s * 100))])
            return r
        # No identifier: search by title.
        first = (surnames(f.get("author", "")) or [None])[0]
        cands = search_crossref(title, first, year_of(f))
        best, best_s = None, 0.0
        for c in cands:
            s = similarity(title, c["title"])
            if s > best_s:
                best, best_s = c, s
        if best_s < MATCH:
            for c in search_openalex(title):
                s = similarity(title, c["title"])
                if s > best_s:
                    best, best_s = c, s
        if best and best_s >= MATCH:
            r.update(status="verified", via="search", doi=best.get("doi"), notes=differences(f, best))
            return r
        note = ("closest: '%s' (%d%%%s)" % (best["title"], round(best_s * 100), ", doi " + best["doi"] if best.get("doi") else "")) if best and best_s >= CLOSE else "no index has a work with this title"
        # Works the indexes rarely hold are not evidence of invention: leave them for the author.
        if kind in ("phdthesis", "mastersthesis", "thesis", "techreport", "unpublished", "manual", "standard"):
            r.update(status="unchecked", via="search", notes=[note, "%s entries are seldom indexed; confirm with the author" % kind])
        elif kind in ("software", "misc", "online", "electronic", "www", "dataset") and f.get("url") and not f.get("journal"):
            r.update(status="unchecked", via="search", notes=[note, "URL-only entry; open %s to confirm" % f["url"]])
        else:
            r.update(status="not found", via="search", notes=[note])
        return r
    except Exception as e:
        r.update(status="unchecked", notes=["network: %s" % e])
        return r


# ------------------------------------------------------------------ main

def main(argv):
    files, as_json, only, offline, workers = [], False, None, False, 4
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            as_json = True
        elif a == "--offline":
            offline = True
        elif a == "--only" and i + 1 < len(argv):
            i += 1
            only = set(x.strip() for x in argv[i].split(","))
        elif a == "--workers" and i + 1 < len(argv):
            i += 1
            workers = max(1, int(argv[i]))
        elif a.startswith("-"):
            print(__doc__, file=sys.stderr)
            return 2
        else:
            files.append(a)
        i += 1
    if not files:
        print(__doc__, file=sys.stderr)
        return 2
    entries = []
    for path in files:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as e:
            print("cannot read %s: %s" % (path, e), file=sys.stderr)
            return 2
        for kind, key, f in parse_bib(text):
            if only and key not in only:
                continue
            entries.append((kind, key, f))
    results = [None] * len(entries)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(check, k, key, f, offline): idx for idx, (k, key, f) in enumerate(entries)}
        for fut in concurrent.futures.as_completed(futs):
            results[futs[fut]] = fut.result()
    if as_json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        width = max([len(r["key"]) for r in results] + [3])
        for r in results:
            line = "%-*s  %-9s" % (width, r["key"], r["status"])
            if r["via"]:
                line += "  via %-8s" % r["via"]
            if r["doi"] and r["status"] == "verified":
                line += "  %s" % r["doi"]
            print(line)
            for n in r["notes"]:
                print(" " * (width + 2) + "- " + n)
        counts = {}
        for r in results:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        print()
        print("%d entries: %s" % (len(results), ", ".join("%d %s" % (counts[k], k) for k in ("verified", "mismatch", "not found", "unchecked") if k in counts)))
    bad = sum(1 for r in results if r["status"] in ("mismatch", "not found"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
