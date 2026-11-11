// Reading a LaTeX build: problems from the .log (built with
// -file-line-error), and the outline from the .tex sources.

import { readTextFile } from "herdr";
import { dirname } from "./util.js";

// A path in the log, made absolute (relative ones are from the main file's
// folder, where latexmk runs).
function absolute(path, dir) {
  if (path.startsWith("/")) return path;
  return `${dir}/${path.replace(/^\.\//, "")}`;
}

// TeX wraps log lines at 79 characters: put wrapped messages back together.
function unwrap(lines, i) {
  let text = lines[i];
  while (lines[i].length >= 79 && i + 1 < lines.length) text += lines[++i];
  return [text, i];
}

// [{kind: "error" | "warning" | "box", file, line, msg}], errors first.
export function parseLog(log, main) {
  const dir = dirname(main);
  const lines = log.split("\n");
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const key = `${p.kind}|${p.file}|${p.line}|${p.msg}`;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  };
  for (let i = 0; i < lines.length; i++) {
    let text;
    [text, i] = unwrap(lines, i);
    let m = /^(.+?\.(?:tex|sty|cls|bib|bbl|ltx|dtx)):(\d+): (.+)$/.exec(text);
    if (m) {
      add({ kind: "error", file: absolute(m[1], dir), line: Number(m[2]), msg: m[3].trim() });
      continue;
    }
    // Errors with no file and line (a missing font, a fatal stop).
    m = /^! ?(.+)$/.exec(text);
    if (m && !/^(Emergency stop|==> Fatal error)/.test(m[1])) {
      add({ kind: "error", file: main, line: null, msg: m[1].trim() });
      continue;
    }
    m = /^(?:LaTeX|Package (\S+)|Class (\S+)|pdfTeX) warning:? ?(.*)$/i.exec(text);
    if (m && /warning/i.test(text)) {
      // A package's warning goes on over lines starting with "(<package>)".
      let msg = m[3];
      const pkg = m[1] || m[2];
      while (pkg && i + 1 < lines.length && lines[i + 1].startsWith(`(${pkg})`)) {
        msg += " " + lines[++i].slice(pkg.length + 2).trim();
      }
      msg = msg.replace(/^Warning:\s*/i, "").trim();
      const at = /on input line (\d+)\.?$/.exec(msg);
      msg = msg.replace(/\s*on input line \d+\.?$/, "").replace(/\.$/, "");
      if (!msg) continue;
      add({ kind: "warning", file: main, line: at ? Number(at[1]) : null, msg: pkg ? `${pkg}: ${msg}` : msg });
      continue;
    }
    m = /^((?:Overfull|Underfull) \\[hv]box \([^)]*\)).*?lines? (\d+)/.exec(text);
    if (m) add({ kind: "box", file: main, line: Number(m[2]), msg: m[1] });
  }
  const rank = { error: 0, warning: 1, box: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// The source without comments (an unescaped % to the end of the line).
const uncomment = (line) => line.replace(/(^|[^\\])%.*$/, "$1");

const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

// [{level, title, file, line}] through \input and \include, 3 deep at most.
export async function outline(main, on) {
  const out = [];
  const seen = new Set();
  const walk = async (file, depth) => {
    if (seen.has(file) || seen.size > 40) return;
    seen.add(file);
    const text = await readTextFile(file, { on }).catch(() => null);
    if (text == null) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = uncomment(lines[i]);
      const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}|\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
      let m;
      while ((m = re.exec(line))) {
        if (m[1]) {
          const title = m[2].replace(/\\[a-zA-Z]+\*?\s*/g, "").replace(/[{}]/g, "").trim();
          out.push({ level: LEVELS[m[1]], title: title || m[1], file, line: i + 1 });
        } else if (depth < 3) {
          let child = m[3].trim();
          if (!/\.tex$/.test(child)) child += ".tex";
          await walk(child.startsWith("/") ? child : `${dirname(main)}/${child}`, depth + 1);
        }
      }
    }
  };
  await walk(main, 0);
  return out;
}
