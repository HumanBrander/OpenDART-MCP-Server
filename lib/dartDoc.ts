// dartDoc.ts — OpenDART 공시 원문(document.xml) 읽기 도구 3종
// 기존 OpenDART MCP 서버(Vercel)의 lib/ 폴더에 넣고, MCP 라우트에서 registerDartDocTools(server, getKey)를 호출합니다.
// 필요 패키지: npm i jszip iconv-lite zod
import JSZip from "jszip";
import iconv from "iconv-lite";
import { z } from "zod";

const DART = "https://opendart.fss.or.kr/api";
const TTL = 10 * 60 * 1000; // 같은 공시를 여러 번 읽을 때 재다운로드 방지(인스턴스가 살아 있는 동안)

type DocFile = { name: string; text: string; sections: Section[] };
type Section = { no: number; level: number; title: string; start: number; end: number };
const cache = new Map<string, { at: number; files: DocFile[] }>();

// ───────────────────────── 원문 다운로드·해석 ─────────────────────────
async function loadDocument(rceptNo: string, apiKey: string): Promise<DocFile[]> {
  const hit = cache.get(rceptNo);
  if (hit && Date.now() - hit.at < TTL) return hit.files;

  const res = await fetch(`${DART}/document.xml?crtfc_key=${apiKey}&rcept_no=${rceptNo}`);
  if (!res.ok) throw new Error(`OpenDART HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 정상 응답은 ZIP(PK로 시작). 오류는 status/message가 담긴 XML·JSON으로 옴
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`OpenDART 오류 응답: ${buf.toString("utf8").slice(0, 300)}`);
  }
  const zip = await JSZip.loadAsync(buf);
  const files: DocFile[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!name.toLowerCase().endsWith(".xml")) continue;
    const raw = await zip.files[name].async("nodebuffer");
    const head = raw.subarray(0, 200).toString("latin1");
    const enc = (/encoding="([^"]+)"/i.exec(head)?.[1] ?? "utf-8").toLowerCase();
    const xml = /euc|ks_c|cp949/.test(enc) ? iconv.decode(raw, "euc-kr") : raw.toString("utf8");
    files.push({ name, ...xmlToText(xml) });
  }
  // 본문은 파일명이 가장 짧은 XML, 나머지는 감사·검토보고서 등 첨부
  files.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  cache.set(rceptNo, { at: Date.now(), files });
  return files;
}

const S1 = "\u0001", S2 = "\u0002", S3 = "\u0003";

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function xmlToText(xml: string): { text: string; sections: Section[] } {
  let s = xml;
  // 1) 장 제목 표시: <SECTION-n> 바로 뒤의 <TITLE>은 n단계, 그 밖의 TITLE은 9단계
  s = s.replace(/<SECTION-(\d)[^>]*>\s*<TITLE[^>]*>([\s\S]*?)<\/TITLE>/g,
    (_, lv, t) => `\n${S1}${lv}${S2}${t.replace(/<[^>]+>/g, "")}${S3}\n`);
  s = s.replace(/<TITLE[^>]*>([\s\S]*?)<\/TITLE>/g,
    (_, t) => `\n${S1}9${S2}${t.replace(/<[^>]+>/g, "")}${S3}\n`);
  // 2) 표: 칸은 ' | ', 행은 줄바꿈
  s = s.replace(/<\/TR>/gi, "\n").replace(/<(TD|TH|TE|TU)\b[^>]*>/gi, " | ");
  s = s.replace(/<\/?(P|BR|TABLE|TBODY|THEAD|PGBRK)\b[^>]*>/gi, "\n");
  // 3) 나머지 태그 제거, 엔티티·공백 정리
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  s = s.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");

  // 4) 표시를 걷어내며 목차(시작 위치) 기록
  const sections: Section[] = [];
  let out = "", last = 0, no = 0;
  const re = new RegExp(`${S1}(\\d)${S2}([^${S3}]*)${S3}`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += s.slice(last, m.index);
    const title = m[2].trim();
    if (title) sections.push({ no: ++no, level: Number(m[1]), title, start: out.length, end: -1 });
    out += `【${title}】`;
    last = re.lastIndex;
  }
  out += s.slice(last);
  // 끝 위치: 같은 단계 이하의 다음 장 시작 전까지(하위 절 포함)
  for (let i = 0; i < sections.length; i++) {
    const nxt = sections.slice(i + 1).find(x => x.level <= sections[i].level);
    sections[i].end = nxt ? nxt.start : out.length;
  }
  return { text: out.trim(), sections };
}

// ───────────────────────── 도구 본체 ─────────────────────────
export async function findReports(
  apiKey: string, corpCode: string, bgnDe: string, endDe: string, kind: string, limit: number,
) {
  const p = new URLSearchParams({
    crtfc_key: apiKey, corp_code: corpCode, bgn_de: bgnDe, end_de: endDe,
    page_count: String(Math.min(limit, 100)), sort: "date", sort_mth: "desc",
  });
  if (kind !== "all") p.set("pblntf_ty", kind);
  const j: any = await (await fetch(`${DART}/list.json?${p}`)).json();
  if (j.status !== "000") return `OpenDART ${j.status}: ${j.message}`;
  return j.list.map((r: any) => `${r.rcept_dt} | ${r.report_nm.trim()} | ${r.flr_nm} | rcept_no=${r.rcept_no}`).join("\n");
}

export async function docOutline(apiKey: string, rceptNo: string, file = 0) {
  const files = await loadDocument(rceptNo, apiKey);
  const f = files[file];
  if (!f) return `file=${file} 없음 (파일 ${files.length}개)`;
  const head = files.map((x, i) => `file=${i}: ${x.name} (${x.text.length.toLocaleString()}자)`).join("\n");
  const toc = f.sections
    .map(s => `${"  ".repeat(Math.min(s.level, 6) - 1)}[${s.no}] ${s.title} (${(s.end - s.start).toLocaleString()}자)`)
    .join("\n");
  return `${head}\n\n목차(file=${file})\n${toc || "(TITLE 없음 — keyword로 읽으세요)"}`;
}

export async function docRead(
  apiKey: string, rceptNo: string,
  o: { section?: number; keyword?: string; skip?: number; offset?: number; file?: number; max_chars?: number },
) {
  const files = await loadDocument(rceptNo, apiKey);
  const f = files[o.file ?? 0];
  if (!f) return `file=${o.file} 없음`;
  const max = Math.min(o.max_chars ?? 5000, 15000);
  const offset = o.offset ?? 0;

  if (o.keyword) {
    const hits: number[] = [];
    const low = f.text.toLowerCase(), kw = o.keyword.toLowerCase();
    for (let i = low.indexOf(kw); i >= 0; i = low.indexOf(kw, i + kw.length)) hits.push(i);
    if (!hits.length) return `'${o.keyword}' 적중 0건 (file=${o.file ?? 0})`;
    const k = Math.min(o.skip ?? 0, hits.length - 1);
    const at = hits[k];
    const start = Math.max(0, at - Math.floor(max * 0.2)) + offset;
    const sec = [...f.sections].reverse().find(s => s.start <= at);
    const body = f.text.slice(start, start + max);
    const more = k + 1 < hits.length ? `\n\n— 다음 적중: skip=${k + 1} (총 ${hits.length}건)` : `\n\n— 마지막 적중 (총 ${hits.length}건)`;
    return `[적중 ${k + 1}/${hits.length} · 위치 섹션: ${sec?.title ?? "표지"}]\n${body}${more} · 이어 읽기: offset=${offset + max}`;
  }

  let a = 0, b = f.text.length, label = "전체";
  if (o.section) {
    const s = f.sections.find(x => x.no === o.section);
    if (!s) return `section=${o.section} 없음 — dart_doc_outline으로 번호 확인`;
    a = s.start; b = s.end; label = s.title;
  }
  const chunk = f.text.slice(a + offset, Math.min(b, a + offset + max));
  const left = b - (a + offset + chunk.length);
  return `[${label}] ${offset.toLocaleString()}자부터\n${chunk}` +
    (left > 0 ? `\n\n— 남은 ${left.toLocaleString()}자 · 이어 읽기: offset=${offset + max}` : "\n\n— 끝");
}

// ───────────────────────── MCP 등록 ─────────────────────────
// server: mcp-handler(또는 @modelcontextprotocol/sdk McpServer) 인스턴스
// getKey: 기존 opendart_* 도구가 ?opendart_key= 에서 키를 꺼내는 함수를 그대로 넘깁니다
// resolveCorp: 기존 opendart_search_company 내부의 회사명·종목코드 → 고유번호 변환 함수를 넘깁니다
export function registerDartDocTools(
  server: any,
  getKey: () => string,
  resolveCorp: (q: string) => Promise<string | null>,
) {
  const txt = (t: string) => ({ content: [{ type: "text", text: t }] });
  const safe = (fn: () => Promise<string>) => fn().then(txt).catch((e: any) => txt(`오류: ${e.message}`));

  server.tool(
    "dart_find_reports",
    "DART 공시 목록과 접수번호(rcept_no)를 찾습니다. kind: A 정기·B 주요사항·D 지분·I 거래소·all",
    {
      company: z.string().describe("종목코드 6자리·고유번호 8자리·회사명"),
      bgn_de: z.string().regex(/^\d{8}$/).describe("시작일 YYYYMMDD"),
      end_de: z.string().regex(/^\d{8}$/).describe("종료일 YYYYMMDD"),
      kind: z.enum(["A", "B", "C", "D", "E", "F", "I", "all"]).default("all"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    (a: any) => safe(async () => {
      const corp = /^\d{8}$/.test(a.company) ? a.company : await resolveCorp(a.company);
      if (!corp) return `회사를 찾지 못했습니다: ${a.company}`;
      return findReports(getKey(), corp, a.bgn_de, a.end_de, a.kind, a.limit);
    }),
  );

  server.tool(
    "dart_doc_outline",
    "공시 원문의 파일 목록과 목차(번호·글자 수)를 돌려줍니다. file=0 본문, 1 이상 첨부(감사·검토보고서)",
    { rcept_no: z.string().regex(/^\d{14}$/), file: z.number().int().min(0).default(0) },
    (a: any) => safe(() => docOutline(getKey(), a.rcept_no, a.file)),
  );

  server.tool(
    "dart_doc_read",
    "공시 원문의 필요한 부분만 텍스트로 읽습니다. section(목차 번호) 또는 keyword로 찾고, skip으로 다음 적중, offset으로 이어 읽기. 표는 '칸 | 칸'",
    {
      rcept_no: z.string().regex(/^\d{14}$/),
      section: z.number().int().optional(),
      keyword: z.string().optional(),
      skip: z.number().int().min(0).default(0),
      offset: z.number().int().min(0).default(0),
      file: z.number().int().min(0).default(0),
      max_chars: z.number().int().min(500).max(15000).default(5000),
    },
    (a: any) => safe(() => docRead(getKey(), a.rcept_no, a)),
  );
}
