// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path exists as a file or a directory in the tree as earlier edits left it. */
  existsAny(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

interface Ctx {
  moves: [string, string][];
  strict: boolean;
}

type Edit = (tree: Tree, ctx: Ctx) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.existsAny(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines, and the file line model (section 3).
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trailStrip = (s: string): string => s.replace(/[ \t]+$/, '');
const bothStrip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trailStrip(s) : bothStrip(s));

/** First tier (0, then 1, then 2; strict: 0 only) at which O occurs, with every occurrence position. */
function findOccurrences(file: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const oN = O.map((l) => normLine(l, t));
    const pos: number[] = [];
    for (let i = 0; i + O.length <= file.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (normLine(file[i + j]!, t) !== oN[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: `text` as the patch wrote it, `ctxO` the index in O when it is a context line. */
interface NLine {
  text: string;
  ctxO: number | null;
}

/** Write N at occurrence `pos`: context lines as the file's own matched line, tier-2 re-indent for the rest. */
function mapN(N: NLine[], file: string[], pos: number, O: string[], tier: number): string[] {
  if (tier !== 2) return N.map((n) => (n.ctxO === null ? n.text : file[pos + n.ctxO]!));
  const F = leadWs(file[pos]!);
  const P = leadWs(O[0]!);
  return N.map((n) => {
    if (n.ctxO !== null) return file[pos + n.ctxO]!;
    const t = n.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  oldRaw: string | null; // path as written after prefix removal; null when /dev/null or absent
  newRaw: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function uniHeaderPath(l: string): string {
  const rest = l.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Parse one hunk starting at `i` (a line starting with @@, already validated); returns the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  const a = Number(m![1]);
  let j = i + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { hunk: { a, body }, next: j };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curFromDiffGit = false;
  let curHasPair = false;
  let inHunks = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldRaw: m[1]!, newRaw: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      curFromDiffGit = true;
      curHasPair = false;
      inHunks = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !inHunks) {
        // A pair in the header (before any hunk) redefines the section's paths,
        // whether or not a `diff --git` line or an earlier pair named them.
        cur.oldRaw = stripAB(uniHeaderPath(l));
        cur.newRaw = stripAB(uniHeaderPath(lines[i + 1]!));
        curHasPair = true;
        i += 2;
        continue;
      }
      cur = { oldRaw: stripAB(uniHeaderPath(l)), newRaw: stripAB(uniHeaderPath(lines[i + 1]!)), isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      curFromDiffGit = false;
      curHasPair = true;
      inHunks = false;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!inHunks) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.newRaw = stripAB(uniHeaderPath(l));
        curHasPair = true;
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!curHasPair) cur.oldRaw = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!curHasPair) cur.newRaw = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        inHunks = true;
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    // After hunks: only a new hunk starts here; everything else is ignored (prose, fences).
    if (l.startsWith('@@')) {
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Split a hunk body into O, N and whether a `\` line follows the hunk's last context or `+` line. */
function hunkON(body: string[]): { O: string[]; N: NLine[]; noNl: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      O.push(t);
      N.push({ text: t, ctxO: O.length - 1 });
      lastIdx = k;
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctxO: null });
      lastIdx = k;
    } else if (l === '') {
      O.push('');
      N.push({ text: '', ctxO: O.length - 1 });
      lastIdx = k;
    }
    // A `\` line refers to the body line before it; it contributes nothing else here.
  }
  const noNl = lastIdx >= 0 && lastIdx + 1 < body.length && body[lastIdx + 1]!.startsWith('\\');
  return { O, N, noNl };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldPath = sec.oldRaw !== null && sec.oldRaw !== '/dev/null' ? sec.oldRaw : null;
    const newPath = sec.newRaw !== null && sec.newRaw !== '/dev/null' ? sec.newRaw : null;
    const oldDevNull = sec.oldRaw === '/dev/null';
    const newDevNull = sec.newRaw === '/dev/null';
    let kind: 'create' | 'delete' | 'move' | 'change';
    if ((sec.isCreate || oldDevNull) && newPath !== null) kind = 'create';
    else if ((sec.isDelete || newDevNull) && oldPath !== null) kind = 'delete';
    else if (oldPath !== null && newPath !== null && oldPath !== newPath) kind = 'move';
    else kind = 'change';
    return (tree: Tree, ctx: Ctx): void => {
      const checkPaths: (string | null)[] =
        kind === 'create' ? [newPath] : kind === 'delete' ? [oldPath] : kind === 'move' ? [oldPath, newPath] : [oldPath ?? newPath];
      for (const p of checkPaths) {
        if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      }
      if (kind === 'create') {
        const np = newPath!;
        if (tree.existsAny(np)) throw new Fail('exists', np);
        const plus: { text: string; noNl: boolean }[] = [];
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k++) {
            const l = h.body[k]!;
            if (l.startsWith('+')) plus.push({ text: l.slice(1), noNl: k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\') });
          }
        }
        const finalBreak = plus.length > 0 && !plus[plus.length - 1]!.noNl;
        tree.now.set(np, serializeFile({ lines: plus.map((p) => p.text), br: '\n', finalBreak }));
        return;
      }
      if (kind === 'delete') {
        const op = oldPath!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const src = oldPath ?? newPath!;
      const before = tree.get(src);
      if (before === null) throw new Fail('missing', src);
      if (kind === 'move' && tree.existsAny(newPath!)) throw new Fail('exists', newPath!);
      const model = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const { O, N, noNl } = hunkON(h.body);
        if (O.length > 0) {
          const found = findOccurrences(model.lines, O, strict);
          if (found === null) throw new Fail('no-match', src);
          const target = h.a - 1 + d;
          let best = found.positions[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.positions) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const runsToEnd = best + O.length === model.lines.length;
          const mapped = mapN(N, model.lines, best, O, found.tier);
          model.lines = [...model.lines.slice(0, best), ...mapped, ...model.lines.slice(best + O.length)];
          if (runsToEnd) model.finalBreak = !noNl;
          d += N.length - O.length;
        } else {
          const ins = Math.min(h.a + d, model.lines.length);
          const runsToEnd = ins === model.lines.length;
          const mapped = N.map((n) => n.text);
          model.lines = [...model.lines.slice(0, ins), ...mapped, ...model.lines.slice(ins)];
          if (runsToEnd) model.finalBreak = !noNl;
          d += N.length;
        }
      }
      const out = serializeFile(model);
      if (kind === 'move') {
        tree.now.set(src, null);
        tree.now.set(newPath!, out);
        ctx.moves.push([src, newPath!]);
      } else {
        tree.now.set(src, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1; // index of the previous block's `>>>>>>> REPLACE` line, or -1
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    const start = prevReplace < 0 ? 0 : prevReplace + 1;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= start; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree, _ctx: Ctx): void => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.oldLines.length === 0) {
        if (tree.existsAny(p)) throw new Fail('exists', p);
        tree.now.set(p, serializeFile({ lines: b.newLines, br: '\n', finalBreak: b.newLines.length > 0 }));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      const found = findOccurrences(model.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const mapped = mapN(
        b.newLines.map((t) => ({ text: t, ctxO: null })),
        model.lines,
        pos,
        b.oldLines,
        found.tier,
      );
      model.lines = [...model.lines.slice(0, pos), ...mapped, ...model.lines.slice(pos + b.oldLines.length)];
      tree.now.set(p, serializeFile(model));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[]; // Add File: the file's lines
  moveTo: string | null;
  moveToPresent: boolean;
  chunks: V4AChunk[];
  updateLine: number; // 1-based line of the `*** Update File:` line
}

/** Collect one chunk's body lines from `raw` starting at `idx`; returns O, N, the next index and whether `*** End of File` ended it. */
function collectChunkBody(raw: { text: string; idx: number }[], idx: number): { O: string[]; N: NLine[]; nextIdx: number; eof: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  let j = idx;
  let eof = false;
  while (j < raw.length) {
    const t = raw[j]!.text;
    if (t.startsWith('@@') || t === '*** End of File') break;
    if (t.startsWith(' ')) {
      const x = t.slice(1);
      O.push(x);
      N.push({ text: x, ctxO: O.length - 1 });
      j += 1;
      continue;
    }
    if (t.startsWith('-')) {
      O.push(t.slice(1));
      j += 1;
      continue;
    }
    if (t.startsWith('+')) {
      N.push({ text: t.slice(1), ctxO: null });
      j += 1;
      continue;
    }
    if (t === '') {
      O.push('');
      N.push({ text: '', ctxO: O.length - 1 });
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${raw[j]!.idx + 1}`);
  }
  if (j < raw.length && raw[j]!.text === '*** End of File') {
    eof = true;
    j += 1;
  }
  return { O, N, nextIdx: j, eof };
}

/** First line at or after `cursor` equal to the anchor, at the first tier where one is (single-line matching). */
function findAnchor(file: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < file.length; i++) {
      if (normLine(file[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/** First occurrence of O at or after `cursor`, at the first tier with one; an EOF chunk takes only one ending at the last line. */
function findFrom(file: string[], O: string[], cursor: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const oN = O.map((l) => normLine(l, t));
    for (let i = cursor; i + O.length <= file.length; i++) {
      if (eof && i + O.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (normLine(file[i + j]!, t) !== oN[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { pos: i, tier: t };
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    const raw: { text: string; idx: number }[] = [];
    i += 1;
    while (i < last) {
      const l2 = lines[i]!;
      if (l2.startsWith('*** Add File: ') || l2.startsWith('*** Delete File: ') || l2.startsWith('*** Update File: ')) break;
      raw.push({ text: l2, idx: i });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, lines: fileLines, moveTo: null, moveToPresent: false, chunks: [], updateLine: startLine });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (blank(r.text)) continue;
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, lines: [], moveTo: null, moveToPresent: false, chunks: [], updateLine: startLine });
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      let moveToPresent = false;
      if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[idx]!.text.slice('*** Move to: '.length).trim();
        moveToPresent = true;
        idx += 1;
      }
      const chunks: V4AChunk[] = [];
      let firstChunk = true;
      let needAnchor = false;
      while (idx < raw.length) {
        const r = raw[idx]!;
        if (r.text === '*** End of File') throw new Exit2(`error: parse ${r.idx + 1}`);
        if (r.text.startsWith('@@')) {
          const anchorText = r.text.slice(2).trim();
          const anchor = anchorText === '' ? null : anchorText;
          idx += 1;
          const body = collectChunkBody(raw, idx);
          chunks.push({ anchor, eof: body.eof, O: body.O, N: body.N });
          idx = body.nextIdx;
          needAnchor = body.eof;
          firstChunk = false;
          continue;
        }
        if (needAnchor || !firstChunk) throw new Exit2(`error: parse ${r.idx + 1}`);
        const body = collectChunkBody(raw, idx);
        chunks.push({ anchor: null, eof: body.eof, O: body.O, N: body.N });
        idx = body.nextIdx;
        needAnchor = body.eof;
        firstChunk = false;
      }
      if (chunks.length === 0 && !moveToPresent) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind, path, lines: [], moveTo, moveToPresent, chunks, updateLine: startLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree, _ctx: Ctx): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.existsAny(sec.path)) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, serializeFile({ lines: sec.lines, br: '\n', finalBreak: sec.lines.length > 0 }));
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree, _ctx: Ctx): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    return (tree: Tree, ctx: Ctx): void => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (sec.moveTo !== null && tree.existsAny(sec.moveTo)) throw new Fail('exists', sec.moveTo);
      const model = parseFile(before);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const found = findAnchor(model.lines, ch.anchor, cursor, strict);
          if (found === null) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        if (ch.O.length === 0) {
          const ins = ch.eof ? model.lines.length : cursor;
          const mapped = ch.N.map((n) => n.text);
          model.lines = [...model.lines.slice(0, ins), ...mapped, ...model.lines.slice(ins)];
          cursor = ins + mapped.length;
          continue;
        }
        const occ = findFrom(model.lines, ch.O, cursor, strict, ch.eof);
        if (occ === null) throw new Fail('no-match', p);
        const mapped = mapN(ch.N, model.lines, occ.pos, ch.O, occ.tier);
        model.lines = [...model.lines.slice(0, occ.pos), ...mapped, ...model.lines.slice(occ.pos + ch.O.length)];
        cursor = occ.pos + mapped.length;
      }
      const out = serializeFile(model);
      if (sec.moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(sec.moveTo, out);
        ctx.moves.push([p, sec.moveTo]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : kind === 'v4a'
              ? v4aEdits(lines, strict)
              : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { moves: [], strict };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M per changed path, with a successful move pair replaced by one R line sorting by <new>.
  interface Row {
    kind: string;
    path: string;
    sortKey: string;
    oldPath?: string;
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ kind: was === null ? 'A' : now === null ? 'D' : 'M', path: p, sortKey: p });
  }
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) === null || tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.get(newP) === null) continue;
    const di = rows.findIndex((r) => r.kind === 'D' && r.path === oldP);
    const ai = rows.findIndex((r) => r.kind === 'A' && r.path === newP);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ kind: 'R', path: newP, sortKey: newP, oldPath: oldP });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const outLines = rows.map((r) => (r.kind === 'R' ? `R ${r.oldPath} -> ${r.path}` : `${r.kind} ${r.path}`));
  if (!check) {
    // Deletions first, so a created file never blocks deleting the path it replaces, and vice versa.
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      if (tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
