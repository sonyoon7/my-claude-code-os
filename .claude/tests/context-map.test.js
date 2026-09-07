/**
 * context-map 스킬이 쓰는 집계 로직(.claude/lib/context-map.js)의 인수 테스트.
 *
 * "AC-<번호>" 접두사는 이 저장소의 다른 테스트(stats.test.js)와 같은 이유로 유지한다 —
 * 실패 원장에서 어떤 인수기준이 깨졌는지 바로 추적하기 위함이다.
 *
 * 실제 `.claude/` 트리는 계속 바뀌므로, 고정된 픽스처(.claude/tests/fixtures/context-map/)를
 * 대상으로 검증한다(fixtures/sudoku-board/와 같은 이유).
 *
 * 실행: node --test .claude/tests/context-map.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  parseImportLines,
  countSize,
  resolveImportTree,
  listSkillManifests,
  listAgentManifests,
  listRegisteredHooks,
  buildContextMap,
} = require("../lib/context-map.js");

const FIXTURES = path.join(__dirname, "fixtures", "context-map");

test("AC-1: parseImportLines는 줄 전체가 @경로인 줄만 인식하고, 문장 속 @는 무시한다", () => {
  const text = "1. 규칙\n연락은 someone@example.com 으로.\n@index.md\n  @spaced.md  \n";
  assert.deepEqual(parseImportLines(text), ["index.md", "spaced.md"]);
});

test("AC-2: countSize는 줄 수·글자 수를 세고, 빈 문자열은 0으로 처리한다", () => {
  assert.deepEqual(countSize(""), { lines: 0, chars: 0 });
  const result = countSize("a\nb\nc");
  assert.equal(result.lines, 3);
  assert.equal(result.chars, 5);
});

test("AC-3: resolveImportTree는 @import 체인을 재귀적으로 따라가며 크기를 합산한다", () => {
  const tree = resolveImportTree(path.join(FIXTURES, "CLAUDE.md"));
  const good = tree.nodes.find((n) => n.path.endsWith("good.md"));

  assert.ok(good, "good.md 노드가 있어야 한다");
  assert.equal(good.lines, 2, "실제 2줄 + 마지막 개행이므로 wc -l 관례상 2줄이어야 한다");
  assert.ok(good.chars > 0);
  assert.ok(tree.totalLines > 0);
  assert.ok(tree.totalChars > 0);
});

test("AC-4: resolveImportTree는 존재하지 않는 import 대상을 예외 없이 missing으로 표시한다", () => {
  const tree = resolveImportTree(path.join(FIXTURES, "CLAUDE.md"));
  const missing = tree.nodes.find((n) => n.path.endsWith("missing.md"));

  assert.ok(missing, "missing.md 노드가 있어야 한다");
  assert.equal(missing.missing, true);
});

test("AC-5: resolveImportTree는 순환 import를 감지해 무한 재귀 없이 멈춘다", () => {
  const tree = resolveImportTree(path.join(FIXTURES, "CLAUDE.md"));
  const cycleNodes = tree.nodes.filter((n) => n.path.endsWith("cycle-a.md"));

  assert.equal(cycleNodes.length, 2, "cycle-a.md는 처음 읽힌 노드 1개 + 순환 감지 노드 1개, 총 2개여야 한다");
  assert.ok(cycleNodes.some((n) => n.cycle === true), "그중 하나는 cycle:true로 표시돼야 한다");
  assert.ok(cycleNodes.some((n) => n.cycle !== true), "다른 하나는 실제로 읽힌 노드여야 한다");
});

test("AC-6: resolveImportTree는 5단계를 넘는 import를 더 읽지 않고 truncated로 표시한다", () => {
  const tree = resolveImportTree(path.join(FIXTURES, "depth-chain", "level1.md"), { maxDepth: 5 });

  for (const level of [1, 2, 3, 4, 5]) {
    const node = tree.nodes.find((n) => n.path.endsWith(`level${level}.md`));
    assert.ok(node && !node.truncated && !node.missing && !node.cycle, `level${level}.md는 정상적으로 읽혀야 한다`);
  }

  const level6 = tree.nodes.find((n) => n.path.endsWith("level6.md"));
  assert.ok(level6 && level6.truncated === true, "level6.md는 depth 6이므로 truncated여야 한다");

  const level7 = tree.nodes.find((n) => n.path.endsWith("level7.md"));
  assert.equal(level7, undefined, "level7.md는 잘려서 아예 방문되지 않아야 한다");
});

test("AC-7: listSkillManifests는 SKILL.md의 name/description과 전체 본문 크기를 함께 낸다", () => {
  const manifests = listSkillManifests(path.join(FIXTURES, "skills"));

  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].name, "sample-skill");
  assert.ok(manifests[0].description.length > 0);
  assert.equal(manifests[0].descriptionChars, manifests[0].description.length);
  assert.ok(manifests[0].fullLines > 0);
  assert.ok(manifests[0].fullChars > manifests[0].descriptionChars, "전체 본문은 description보다 커야 한다");
});

test("AC-8: listAgentManifests는 name/description과 함께 tools도 낸다", () => {
  const manifests = listAgentManifests(path.join(FIXTURES, "agents"));

  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].name, "sample-agent");
  assert.equal(manifests[0].tools, "Read");
});

test("AC-9: listRegisteredHooks는 settings.json의 hooks 트리를 평탄화하고, 파일이 없어도 예외 없이 빈 배열을 낸다", () => {
  const hooks = listRegisteredHooks(path.join(FIXTURES, "settings.json"));

  assert.equal(hooks.length, 2);
  assert.ok(hooks.some((h) => h.event === "Stop" && h.matcher === null));
  assert.ok(hooks.some((h) => h.event === "PostToolUse" && h.matcher === "Skill"));

  const missing = listRegisteredHooks(path.join(FIXTURES, "does-not-exist.json"));
  assert.deepEqual(missing, []);
});

test("AC-10: buildContextMap은 실제 지침 파일이 있을 때만 note를 비운다", () => {
  const withGuideline = buildContextMap({ projectDir: path.join(FIXTURES, "sample-project") });
  assert.equal(withGuideline.note, null);
  assert.equal(withGuideline.skills.length, 1);
  assert.equal(withGuideline.agents.length, 1);
  assert.equal(withGuideline.hooks.length, 2);
  assert.ok(withGuideline.importTree.totalLines > 0);

  const empty = buildContextMap({ projectDir: path.join(FIXTURES, "sample-project-empty") });
  assert.ok(typeof empty.note === "string" && empty.note.includes("아직"));
  assert.equal(empty.skills.length, 0, "스킬 디렉터리가 없으면 빈 배열이어야 한다(예외 아님)");
});

// --- 컨텍스트 예산 요약 (2026-09-07 추가) ---
// 상시 비용을 무엇으로 셀지 한 곳에 고정하기 위한 함수. 호출부마다 덧셈을 다시 하면
// 같은 저장소를 두고 사람마다 다른 수치를 말하게 된다.

const { summarizeBudget } = require("../lib/context-map.js");

const FAKE_MAP = {
  importTree: { nodes: [], totalLines: 0, totalChars: 100 },
  skills: [{ descriptionChars: 30 }, { descriptionChars: 20 }],
  agents: [{ descriptionChars: 10 }],
  hooks: [{}, {}, {}],
  onDemandTotals: { skillsFullChars: 900, agentsFullChars: 400 },
};

test("AC-B1: 상시 로드는 import 전문 + 스킬·에이전트 description의 합이다", () => {
  const budget = summarizeBudget(FAKE_MAP);
  assert.deepStrictEqual(budget.alwaysLoaded, {
    importChars: 100,
    skillDescChars: 50,
    agentDescChars: 10,
    total: 160,
  });
});

test("AC-B2: 스킬·에이전트 본문은 온디맨드로만 세고 상시 비용에 넣지 않는다", () => {
  const budget = summarizeBudget(FAKE_MAP);
  assert.strictEqual(budget.onDemand.total, 1300);
  assert.ok(budget.alwaysLoaded.total < budget.onDemand.total);
});

test("AC-B3: 훅은 컨텍스트 비용이 0이므로 글자가 아니라 개수만 센다", () => {
  const budget = summarizeBudget(FAKE_MAP);
  assert.deepStrictEqual(budget.zeroCost, { hooks: 3 });
});

test("AC-B4: 실제 저장소에서도 상시 로드가 온디맨드보다 작다", () => {
  const path = require("node:path");
  const { buildContextMap } = require("../lib/context-map.js");
  const budget = summarizeBudget(buildContextMap({ projectDir: path.resolve(__dirname, "..", "..") }));
  assert.ok(budget.alwaysLoaded.total > 0);
  assert.ok(
    budget.alwaysLoaded.total < budget.onDemand.total,
    `상시 ${budget.alwaysLoaded.total}자가 온디맨드 ${budget.onDemand.total}자보다 커졌습니다 — 요약만 있어야 할 곳에 본문이 들어갔는지 확인하세요`
  );
});

// --- 08 개요 다이어그램의 수치가 낡았는지 감시 (2026-09-07 추가) ---
// `docs-diagrams.md`는 "문서에 지금 이 순간의 수치를 박지 않는다"를 규칙으로 두고,
// 08 개요 다이어그램만 예외로 뒀다. 예외의 조건은 "낡으면 드러난다"였는데, 그 드러남을
// 사람의 주의력에 맡기면 반드시 놓친다 — 실제로 예외를 만든 지 20분 만에 246자가 어긋났다.
// 그래서 드러나는 경로 자체를 테스트로 만든다. 지침을 고치면 이 테스트가 빨간불이 되고,
// `docs/diagrams/README.md`의 재생성 명령 한 줄로 고친다.

test("AC-B5: 08 개요 다이어그램의 수치가 실측과 일치한다", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const projectDir = path.resolve(__dirname, "..", "..");
  const mmdPath = path.join(projectDir, "docs", "diagrams", "08-context-overview.mmd");
  if (!fs.existsSync(mmdPath)) return; // 다이어그램이 없으면 검사할 것도 없다

  const mmd = fs.readFileSync(mmdPath, "utf-8");
  const budget = summarizeBudget(buildContextMap({ projectDir }));
  const withComma = (n) => n.toLocaleString("en-US");

  const claims = [
    ["항상 로드 합계", budget.alwaysLoaded.total],
    ["@import 체인", budget.alwaysLoaded.importChars],
    ["스킬 description", budget.alwaysLoaded.skillDescChars],
    ["에이전트 description", budget.alwaysLoaded.agentDescChars],
    ["온디맨드 합계", budget.onDemand.total],
  ];

  const stale = claims.filter(([, actual]) => !mmd.includes(withComma(actual)));
  assert.deepStrictEqual(
    stale.map(([label, actual]) => `${label}: 실측 ${withComma(actual)}자가 다이어그램에 없습니다`),
    [],
    "08-context-overview.mmd 의 수치가 낡았습니다. .mmd 를 고치고 docs/diagrams/README.md 의 명령으로 .svg 를 다시 생성하세요"
  );
});
