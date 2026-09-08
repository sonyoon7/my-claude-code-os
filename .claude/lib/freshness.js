/**
 * 문서에 박힌 "사실 주장"이 실측과 어긋났는지 검사한다.
 *
 * ## 왜 필요한가
 *
 * `.claude/context/docs-diagrams.md`가 이미 규칙을 갖고 있다 — "문서에 지금 이 순간의
 * 수치를 박아 넣지 않는다. 수치는 스킬이 실행 시점에 집계한다." 예외는 08 개요
 * 다이어그램 하나뿐이고, 그 예외에도 "낡으면 드러날 경로를 함께 둔다"는 조건이 붙었다.
 *
 * 그런데 2026-09-08 전수 조사에서 20곳 이상이 이미 틀려 있었다. `OS.md:160`은
 * "이전 판 수치가 이미 낡아 있었다 — 셀 때마다 재확인하는 습관을 들인다"고 교훈까지
 * 적어 놓고 **다시 낡았다.** `hook-discipline.md`의 "성실성에 기대면 바쁠 때 빠진다"가
 * 문서 계층에서 그대로 재현된 것이다.
 *
 * ## 설계 — 지우고, 못 지우는 것만 등록한다
 *
 * 낡음을 막는 길은 둘뿐이다: 낡을 수 있는 것을 없애거나, 남는 것을 기계가 감시하거나.
 * 그래서 실행 시점에 답할 수 있는 값은 문서에서 **지웠고**, 지우면 목적이 사라지는
 * 자리(개요 다이어그램)만 `docs/facts-registry.json`에 **등록**해 이 파일이 감시한다.
 *
 * ## 이 파일이 검증하지 **못하는** 것
 *
 * **등록되지 않은 수치는 감지하지 못한다.** 새 문서에 숫자를 적고 등록을 안 하면
 * 조용히 낡는다. 자유 텍스트에서 "이 숫자가 무엇을 주장하는가"를 알아내는 것은
 * 정규식으로 풀 수 없다 — 이 저장소가 네 번 확인한 사실이다
 * (`docs/context-ab-test.md:62-63, 121-125, 190-196` 및 실험 4).
 * 그래서 시도하지 않고 한계로 남긴다. 등록부를 채우는 것은 사람의 몫이다.
 */
const fs = require("node:fs");
const path = require("node:path");

const { buildContextMap, summarizeBudget } = require("./context-map.js");

/** 등록부가 쓸 수 있는 사실 이름. 오타를 조용히 통과시키지 않으려고 명시해 둔다. */
const KNOWN_FACTS = [
  "skillCount",
  "agentCount",
  "hookCount",
  "guidelineCount",
  "mcpServerCount",
  "diagramCount",
  "testFileCount",
  "testCount",
  "alwaysLoadedTotal",
  "importChars",
  "skillDescChars",
  "agentDescChars",
  "onDemandTotal",
  "onDemandSkillsChars",
  "onDemandAgentsChars",
];

/**
 * `.claude/tests/*.test.js` 의 파일 수와 그 안에 선언된 테스트 수를 센다.
 *
 * 테스트를 **실행하지 않고** 정적으로 센다. 실행해서 세면 이 검사가 테스트 스위트에
 * 의존하게 되어, 하나가 깨지면 낡음 검사까지 같이 죽는다. 근사값이라는 대가를 치른다 —
 * 반복문으로 동적 생성하는 테스트는 빠진다(현재 저장소에는 없으나 보장은 아니다).
 */
function countTests(testsDir, options = {}) {
  const { existsSync = fs.existsSync, readdirSync = fs.readdirSync, readFileSync = fs.readFileSync } = options;
  if (!existsSync(testsDir)) return { testFileCount: 0, testCount: 0 };

  const files = readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => path.join(testsDir, entry.name));

  let testCount = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    // 줄 맨 앞의 `test(` 선언만 센다. 주석이나 문자열 속 "test("에 걸리지 않게
    // 들여쓰기 0단계로 한정했다 — 이 저장소의 테스트는 전부 최상위 선언이다.
    const matches = text.match(/^test\s*\(/gm);
    testCount += matches ? matches.length : 0;
  }
  return { testFileCount: files.length, testCount };
}

/** `docs/diagrams/*.mmd` 개수. `.svg`는 생성물이므로 세지 않는다. */
function countDiagrams(diagramsDir, options = {}) {
  const { existsSync = fs.existsSync, readdirSync = fs.readdirSync } = options;
  if (!existsSync(diagramsDir)) return 0;
  return readdirSync(diagramsDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".mmd")
  ).length;
}

/**
 * 저장소의 현재 사실을 한 사전으로 모은다.
 *
 * 개수·자수는 대부분 `context-map.js`가 이미 재고 있으므로 그대로 재사용한다.
 * 여기서 새로 세는 것은 테스트 수와 다이어그램 수 둘뿐이다.
 */
function collectFacts({ projectDir, fsOverrides = {} }) {
  const map = buildContextMap({ projectDir, fsOverrides });
  const budget = summarizeBudget(map);

  // depth 1은 CLAUDE.md, depth 2는 index.md(레지스트리) 자신이다.
  // 실제 지침은 depth 3부터 — buildContextMap의 hasRealGuidelines와 같은 기준을 쓴다.
  const guidelineCount = map.importTree.nodes.filter(
    (node) => node.depth > 2 && !node.missing && !node.cycle && !node.truncated
  ).length;

  const { testFileCount, testCount } = countTests(path.join(projectDir, ".claude", "tests"), fsOverrides);

  return {
    skillCount: map.skills.length,
    agentCount: map.agents.length,
    hookCount: map.hooks.length,
    guidelineCount,
    mcpServerCount: budget.unmeasured.mcpServerCount,
    diagramCount: countDiagrams(path.join(projectDir, "docs", "diagrams"), fsOverrides),
    testFileCount,
    testCount,
    alwaysLoadedTotal: budget.alwaysLoaded.total,
    importChars: budget.alwaysLoaded.importChars,
    skillDescChars: budget.alwaysLoaded.skillDescChars,
    agentDescChars: budget.alwaysLoaded.agentDescChars,
    onDemandTotal: budget.onDemand.total,
    onDemandSkillsChars: budget.onDemand.skillsFullChars,
    onDemandAgentsChars: budget.onDemand.agentsFullChars,
  };
}

/** 숫자를 등록부가 지정한 표기로 바꾼다. `14`와 `15,259`는 다른 문자열이다. */
function formatFact(value, format) {
  return format === "comma" ? value.toLocaleString("en-US") : String(value);
}

/**
 * 등록된 주장이 문서 안에 그 값으로 들어 있는지 본다.
 *
 * ## 왜 값만 찾으면 안 되는가 — 실측으로 확인한 실패
 *
 * 처음에는 "파일 어딘가에 이 숫자가 있는가"만 봤다(AC-B5, `context-map.test.js:197`과
 * 같은 방식). 그런데 08 다이어그램의 `스킬 14개`를 일부러 `스킬 99개`로 바꿔도
 * **검사가 통과했다.** 같은 파일 다른 줄에 "14개 · 스킬 선택의 유일한 근거"가 있어서
 * "파일에 14가 있다"가 여전히 참이었기 때문이다.
 *
 * 즉 파일 단위 검사는 **주장이 여러 개인 문서에서 원리적으로 무력하다.** 그래서
 * 등록부가 값이 아니라 **문맥(`pattern`)** 을 등록하게 바꿨다. `"스킬 {v}개"` 처럼
 * 주장이 실제로 쓰인 모양을 적으면, 그 자리가 바뀌어야만 통과한다.
 *
 * 숫자 경계도 함께 본다 — `14`가 `144`나 `1,145`에 걸리면 안 되고, 08의 "상시의 4.3배"
 * 때문에 `4`가 소수점 앞자리에 걸려도 안 된다. 느슨한 일치는 **검사를 통과시키는
 * 방향으로** 틀리기 때문에 더 위험하다.
 */
function textClaimsValue(text, expected, pattern) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundedValue = `(?<![\\d,.])${escapeRe(expected)}(?![\\d,]|\\.\\d)`;

  if (!pattern) return new RegExp(boundedValue).test(text);

  // pattern 은 `{v}` 자리에 값이 들어가는 문자열이다. 나머지는 그대로 찾는다.
  const source = pattern.split("{v}").map(escapeRe).join(boundedValue);
  return new RegExp(source).test(text);
}

/**
 * 생성된 SVG는 mermaid가 **단어마다 `<tspan>`으로 쪼개** 놓아서 `"스킬 14개"` 같은
 * 문맥 패턴이 통째로는 절대 나오지 않는다. 태그와 공백을 걷어내 한 줄로 만든 뒤 비교한다.
 *
 * 공백까지 지우는 이유: 쪼개진 tspan 사이에 공백이 있을 수도 없을 수도 있어서,
 * 남겨 두면 파일마다 결과가 달라진다. 패턴도 같은 방식으로 정규화해 짝을 맞춘다.
 *
 * 한계: 이 정규화는 **텍스트 순서만** 보존한다. 시각적 배치가 바뀌어도 잡지 못한다.
 */
function normalizeForMatch(text, filePath) {
  if (!filePath.endsWith(".svg")) return text;
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
}

/**
 * 등록부의 각 주장을 실측과 대조한다.
 *
 * 파일이 없으면 **조용히 통과시키지 않는다.** AC-B5의 `if (!existsSync) return;`
 * (`context-map.test.js:185`)은 다이어그램을 지우면 검사가 사라지는 사각지대를 만들었다.
 * 같은 실수를 반복하지 않으려고 `missingFile`로 따로 보고한다.
 */
function checkRegistry({ facts, registry, projectDir, fsOverrides = {} }) {
  const { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = fsOverrides;
  const result = { ok: [], stale: [], missingFile: [], unknownFact: [] };
  const cache = new Map();

  for (const entry of registry) {
    const label = entry.label || `${entry.file} → ${entry.fact}`;

    if (!KNOWN_FACTS.includes(entry.fact)) {
      result.unknownFact.push(`${label}: 알 수 없는 사실 이름 "${entry.fact}"`);
      continue;
    }

    const abs = path.join(projectDir, entry.file);
    if (!cache.has(abs)) {
      cache.set(abs, existsSync(abs) ? readFileSync(abs, "utf-8") : null);
    }
    const text = cache.get(abs);
    if (text === null) {
      result.missingFile.push(`${label}: 등록된 파일이 없습니다 (${entry.file})`);
      continue;
    }

    const expected = formatFact(facts[entry.fact], entry.format);
    const haystack = normalizeForMatch(text, entry.file);
    const needle = entry.pattern ? normalizeForMatch(entry.pattern, entry.file) : undefined;
    if (textClaimsValue(haystack, expected, needle)) {
      result.ok.push(label);
    } else {
      const shown = entry.pattern ? `"${entry.pattern.replace("{v}", expected)}"` : expected;
      result.stale.push(`${label}: 실측 ${shown} 이(가) ${entry.file} 안에 없습니다`);
    }
  }
  return result;
}

/**
 * 등록부 파일을 읽는다. 없으면 빈 배열 — 등록부가 없는 저장소에서도 이 lib이 돌아야 한다.
 *
 * 파일 최상위는 `claims` 배열과 `_`로 시작하는 설명 필드로 되어 있다. JSON에는 주석을
 * 달 수 없는데, 등록부는 "왜 이 값이 여기 있나"를 읽는 사람이 가장 궁금해할 파일이라
 * 설명을 파일 안에 두는 쪽을 택했다. 배열만 반환해 호출부는 그 구분을 몰라도 된다.
 */
function loadRegistry({ projectDir, fsOverrides = {} }) {
  const { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = fsOverrides;
  const registryPath = path.join(projectDir, "docs", "facts-registry.json");
  if (!existsSync(registryPath)) return [];
  const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
  return Array.isArray(parsed) ? parsed : parsed.claims || [];
}

/** 스킬·테스트가 함께 쓰는 한 줄 진입점. */
function auditFreshness({ projectDir, fsOverrides = {} }) {
  const facts = collectFacts({ projectDir, fsOverrides });
  const registry = loadRegistry({ projectDir, fsOverrides });
  const check = checkRegistry({ facts, registry, projectDir, fsOverrides });
  return {
    facts,
    ...check,
    registered: registry.length,
    // 위반 0개가 "문서가 최신"이라는 뜻이 아니다. 등록되지 않은 수치는 보지 않는다.
    // context-inject.js가 같은 이유로 결과에 한계를 함께 싣는다 — 그 관례를 따른다.
    caveat:
      "이 검사는 docs/facts-registry.json 에 등록된 주장만 봅니다. " +
      "등록되지 않은 수치가 문서에 있으면 낡아도 드러나지 않습니다.",
  };
}

module.exports = {
  KNOWN_FACTS,
  countTests,
  countDiagrams,
  collectFacts,
  formatFact,
  textClaimsValue,
  normalizeForMatch,
  checkRegistry,
  loadRegistry,
  auditFreshness,
};
