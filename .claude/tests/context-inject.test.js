const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { auditInjection, auditRegistry, listGuidelineFiles } = require("../lib/context-inject.js");

const ROOT = path.resolve("/proj");

/** 메모리 파일시스템. lib이 fs를 주입받게 만들어 둔 덕에 실제 디스크 없이 검증한다. */
function fakeFs(files) {
  const map = new Map(Object.entries(files).map(([key, value]) => [path.resolve(key), value]));
  const norm = (p) => path.resolve(p);
  return {
    existsSync: (p) =>
      map.has(norm(p)) || [...map.keys()].some((key) => key.startsWith(`${norm(p)}${path.sep}`)),
    readFileSync: (p) => {
      const value = map.get(norm(p));
      if (value === undefined) throw new Error(`ENOENT: ${p}`);
      return value;
    },
    readdirSync: (p) => {
      const prefix = `${norm(p)}${path.sep}`;
      const names = new Set();
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split(path.sep)[0]);
      }
      return [...names].sort();
    },
  };
}

const ctx = (name) => `${ROOT}/.claude/context/${name}`;
const agent = (name) => `${ROOT}/.claude/agents/${name}`;

const REGISTRY = "# 레지스트리\n\n@alpha.md\n@beta.md\n";
const JUDGE = [
  "---",
  "name: judge",
  "description: 두 입력만 보고 독립적으로 판정해 PASS/FAIL을 돌려주는 서브에이전트.",
  "---",
  "",
  "본문",
].join("\n");
const BUILDER = [
  "---",
  "name: builder",
  "description: 초안을 작성해 돌려주는 실행형 서브에이전트. 판정하지 않는다.",
  "---",
  "",
  "@../context/index.md",
  "",
  "먼저 `.claude/context/index.md` 를 읽는다.",
].join("\n");

function baseTree(extra = {}) {
  return {
    [ctx("index.md")]: REGISTRY,
    [ctx("README.md")]: "계층 설명",
    [ctx("alpha.md")]: "지침 A",
    [ctx("beta.md")]: "지침 B",
    [agent("judge.md")]: JUDGE,
    [agent("builder.md")]: BUILDER,
    ...extra,
  };
}

const audit = (tree) => auditInjection({ projectDir: ROOT, fsOverrides: fakeFs(tree) });

test("AC-1: 등록과 파일이 일치하고 에이전트 표식이 맞으면 위반이 없다", () => {
  const result = audit(baseTree());
  assert.deepStrictEqual(result.violations, []);
  assert.strictEqual(result.ok, true);
});

test("AC-2: 파일은 있는데 index.md에 등록되지 않으면 고아로 잡는다", () => {
  const result = audit(baseTree({ [ctx("gamma.md")]: "등록 안 된 지침" }));
  assert.strictEqual(result.registry.orphans.length, 1);
  assert.match(result.violations.join("\n"), /고아 지침: gamma\.md/);
});

test("AC-3: 등록됐는데 파일이 없으면 끊어진 등록으로 잡는다", () => {
  const tree = baseTree();
  tree[ctx("index.md")] = `${REGISTRY}@delta.md\n`;
  const result = audit(tree);
  assert.deepStrictEqual(result.registry.missing, ["delta.md"]);
  assert.match(result.violations.join("\n"), /끊어진 등록/);
});

test("AC-4: 루트 기준 경로로 등록하면 경로 오기로 잡는다 (조용한 누락의 원인)", () => {
  const tree = baseTree();
  tree[ctx("index.md")] = "@.claude/context/alpha.md\n@beta.md\n";
  const result = audit(tree);
  assert.deepStrictEqual(result.registry.badPaths, [".claude/context/alpha.md"]);
  assert.match(result.violations.join("\n"), /경로 오기/);
});

test("AC-5: index.md와 README.md는 지침으로 세지 않는다", () => {
  const files = listGuidelineFiles(`${ROOT}/.claude/context`, fakeFs(baseTree()));
  assert.deepStrictEqual(files, ["alpha.md", "beta.md"]);
});

test("AC-6: 독립 판정 에이전트에 @import 줄이 있으면 차단 위반", () => {
  const tree = baseTree();
  tree[agent("judge.md")] = JUDGE.replace("본문", "@../context/index.md\n본문");
  const result = audit(tree);
  assert.match(result.violations.join("\n"), /차단 위반: judge/);
});

test("AC-7: 독립 판정 에이전트에 읽기 지시만 있어도 차단 위반", () => {
  const tree = baseTree();
  tree[agent("judge.md")] = JUDGE.replace("본문", "먼저 .claude/context/index.md 를 읽는다");
  const result = audit(tree);
  assert.match(result.violations.join("\n"), /차단 위반: judge/);
});

test("AC-8: 비독립 에이전트에 주입 표식이 하나도 없으면 주입 누락", () => {
  const tree = baseTree();
  tree[agent("builder.md")] = BUILDER.split("\n").slice(0, 5).join("\n");
  const result = audit(tree);
  assert.match(result.violations.join("\n"), /주입 누락: builder/);
});

test("AC-9: @import 줄만 있고 읽기 지시가 없으면 주입 불완전", () => {
  const tree = baseTree();
  tree[agent("builder.md")] = BUILDER.replace("먼저 `.claude/context/index.md` 를 읽는다.", "본문");
  const result = audit(tree);
  assert.match(result.violations.join("\n"), /주입 불완전: builder .*읽기 지시/);
});

test("AC-10: 읽기 지시만 있고 @import 줄이 없으면 주입 불완전", () => {
  const tree = baseTree();
  tree[agent("builder.md")] = BUILDER.replace("@../context/index.md", "");
  const result = audit(tree);
  assert.match(result.violations.join("\n"), /주입 불완전: builder .*@import 줄/);
});

test("AC-11: 두 표식이 모두 있으면 주입으로 인정한다", () => {
  const result = audit(baseTree());
  const builder = result.agents.find((a) => a.name === "builder");
  assert.strictEqual(builder.injected, true);
  assert.strictEqual(builder.expected, "주입");
});

test("AC-12: counts가 지침 수·주입 수·차단 수를 정확히 센다", () => {
  const result = audit(baseTree());
  assert.deepStrictEqual(result.counts, { guidelines: 2, injectedAgents: 1, blockedAgents: 1 });
});

test("AC-13: agents 디렉터리가 없으면 에이전트 감사는 빈 배열", () => {
  const tree = {
    [ctx("index.md")]: REGISTRY,
    [ctx("alpha.md")]: "A",
    [ctx("beta.md")]: "B",
  };
  const result = audit(tree);
  assert.deepStrictEqual(result.agents, []);
  assert.deepStrictEqual(result.violations, []);
});

test("AC-14: index.md 자체가 없으면 모든 지침이 고아가 된다", () => {
  const tree = baseTree();
  delete tree[ctx("index.md")];
  const registry = auditRegistry({ projectDir: ROOT, fsOverrides: fakeFs(tree) });
  assert.deepStrictEqual(registry.orphans, ["alpha.md", "beta.md"]);
});

test("AC-15: 레지스트리가 아닌 다른 파일을 가리키는 @ 줄은 주입으로 치지 않는다", () => {
  const tree = baseTree();
  tree[agent("builder.md")] = BUILDER.replace("@../context/index.md", "@../context/alpha.md");
  const result = audit(tree);
  const builder = result.agents.find((a) => a.name === "builder");
  assert.strictEqual(builder.hasImportLine, false);
  assert.match(result.violations.join("\n"), /주입 불완전: builder/);
});

// --- 실제 저장소를 대상으로 한 회귀 방지 테스트 ---
// 위 AC들은 로직이 옳은지 보고, 아래는 "지금 이 저장소가 실제로 정합한지"를 본다.
// 지침 파일을 새로 만들고 index.md 등록을 잊거나, 독립 심판에 실수로 지침을 물리면
// 여기서 빨간불이 뜬다. 감사 결과를 사람이 기억해서 돌리는 데 기대지 않기 위한 장치다.

test("AC-16: 이 저장소의 주입 상태에 위반이 없다", () => {
  const projectDir = path.resolve(__dirname, "..", "..");
  const result = auditInjection({ projectDir });
  assert.deepStrictEqual(result.violations, [], `주입 위반:\n${result.violations.join("\n")}`);
});

test("AC-17: 이 저장소의 지침이 5개 이상이고 최소 1개 서브에이전트가 주입받는다", () => {
  const projectDir = path.resolve(__dirname, "..", "..");
  const { counts } = auditInjection({ projectDir });
  assert.ok(counts.guidelines >= 5, `지침 ${counts.guidelines}개 — 5개 이상이어야 한다`);
  assert.ok(counts.injectedAgents >= 1, "지침을 주입받는 서브에이전트가 최소 1개여야 한다");
  assert.ok(counts.blockedAgents >= 1, "독립 판정 에이전트는 차단된 채로 남아야 한다");
});
