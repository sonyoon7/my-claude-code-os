/**
 * 개인 지침(.claude/context/)의 **주입 상태**를 감사한다.
 *
 * `context-map.js`가 "무엇이 얼마나 로드되는가"(양)를 보여준다면, 이 파일은
 * "주입되어야 할 곳에 주입됐고, 주입되면 안 되는 곳에 안 됐는가"(정합성)를 본다.
 *
 * ## 왜 별도 정책 파일을 두지 않는가
 * 주입 여부를 적어 두는 JSON을 따로 만들면 그 파일과 실제 파일이 어긋날 수 있고,
 * 어긋나도 아무도 모른다. 그래서 **진실 원천을 파일 자체**로 뒀다. 두 신호를 각각
 * 다른 곳에서 읽어 서로 모순되는지만 본다:
 *   - 기대: 서브에이전트의 `description`에 "독립적으로 판정"이 있는가
 *           → 있으면 컨텍스트 차단 대상, 없으면 주입 대상
 *   - 실제: 그 파일 본문에 레지스트리(.claude/context/index.md)를 가리키는
 *           `@import` 줄과 읽기 지시가 있는가
 * 둘 다 파일에서 읽지만 **서로 다른 곳에서** 읽으므로, 한쪽만 고치면 감사가 잡아낸다.
 *
 * ## 왜 "독립적으로 판정"을 표식으로 쓰는가
 * 이름 목록(policy-reviewer, test-reviewer, …)을 코드에 박으면 새 서브에이전트가
 * 생기는 순간 낡는다. 세 리뷰어는 이미 description에 자기가 독립 심판임을 적어 두고
 * 있으므로(2026-08-26 이래의 관례), 그 문구를 그대로 정책 표식으로 삼는다.
 * 컨텍스트 차단은 사고가 아니라 설계다 — `OS.md` 2026-08-28 참고.
 *
 * 순수 함수만 담고 fs는 주입받는다(stats.js·context-map.js와 같은 관례).
 * .claude/tests/context-inject.test.js 가 검증한다.
 */
const fs = require("node:fs");
const path = require("node:path");

const { parseImportLines, parseFrontmatter, resolveImportPath } = require("./context-map.js");

/** 지침이 아니라 계층 자체를 설명하는 파일. 등록 대상에서 제외한다. */
const NON_GUIDELINE_FILES = new Set(["index.md", "README.md"]);

/** description에 이 문구가 있으면 컨텍스트 차단 대상(독립 심판)으로 본다. */
const INDEPENDENCE_MARKER = "독립적으로 판정";

/** 레지스트리를 루트 기준 경로로 잘못 적는 실전 함정. index.md 기준 상대경로여야 한다. */
const ROOT_RELATIVE_PREFIX = ".claude/";

/** `.claude/context/`에 실제로 존재하는 지침 파일 이름 목록. */
function listGuidelineFiles(contextDir, options = {}) {
  const { existsSync = fs.existsSync, readdirSync = fs.readdirSync } = options;
  if (!existsSync(contextDir)) return [];
  return readdirSync(contextDir)
    .filter((name) => name.endsWith(".md") && !NON_GUIDELINE_FILES.has(name))
    .sort();
}

/**
 * 레지스트리(index.md)와 실제 파일을 대조한다.
 * @returns {{registered: string[], files: string[], orphans: string[], missing: string[], badPaths: string[]}}
 */
function auditRegistry({ projectDir, fsOverrides = {} }) {
  const { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = fsOverrides;
  const contextDir = path.join(projectDir, ".claude", "context");
  const indexPath = path.join(contextDir, "index.md");

  const files = listGuidelineFiles(contextDir, fsOverrides);
  if (!existsSync(indexPath)) {
    return { registered: [], files, orphans: files, missing: [], badPaths: [] };
  }

  const registered = parseImportLines(readFileSync(indexPath, "utf-8"));
  const badPaths = registered.filter((entry) => entry.startsWith(ROOT_RELATIVE_PREFIX));

  const resolved = registered.map((entry) => resolveImportPath(entry, contextDir));
  const missing = registered.filter((entry, i) => !existsSync(resolved[i]));
  const registeredNames = new Set(resolved.map((abs) => path.basename(abs)));
  const orphans = files.filter((name) => !registeredNames.has(name));

  return { registered, files, orphans, missing, badPaths };
}

/**
 * 서브에이전트 하나의 기대(독립 심판인가)와 실제(주입 표식이 있는가)를 읽는다.
 */
function inspectAgent(agentPath, registryPath, options = {}) {
  const { readFileSync = fs.readFileSync } = options;
  const text = readFileSync(agentPath, "utf-8");
  const frontmatter = parseFrontmatter(text);
  const agentDir = path.dirname(agentPath);

  const hasImportLine = parseImportLines(text).some(
    (entry) => path.resolve(resolveImportPath(entry, agentDir)) === path.resolve(registryPath)
  );

  // `@` 줄이 서브에이전트 파일에서도 해석되는지는 확인되지 않았다(2026-09-07 미해결 가정).
  // 그래서 본문에 "레지스트리를 읽어라"는 지시도 함께 요구한다 — 둘 중 하나만으로는
  // 주입을 보장할 수 없기 때문이다. 지시문은 `@` 줄이 아닌 곳에서 레지스트리 경로를 언급한다.
  const withoutImportLines = text
    .split(/\r?\n/)
    .filter((line) => !/^@\S+$/.test(line.trim()))
    .join("\n");
  const hasReadStep = withoutImportLines.includes(".claude/context/index.md");

  return {
    name: frontmatter.name || path.basename(agentPath, ".md"),
    independent: (frontmatter.description || "").includes(INDEPENDENCE_MARKER),
    hasImportLine,
    hasReadStep,
  };
}

/** `.claude/agents/*.md` 전체를 감사한다. */
function auditAgents({ projectDir, fsOverrides = {} }) {
  const { existsSync = fs.existsSync, readdirSync = fs.readdirSync } = fsOverrides;
  const agentsDir = path.join(projectDir, ".claude", "agents");
  const registryPath = path.join(projectDir, ".claude", "context", "index.md");
  if (!existsSync(agentsDir)) return [];

  return readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const info = inspectAgent(path.join(agentsDir, name), registryPath, fsOverrides);
      const injected = info.hasImportLine && info.hasReadStep;
      const partial = (info.hasImportLine || info.hasReadStep) && !injected;
      return {
        ...info,
        injected,
        expected: info.independent ? "차단" : "주입",
        ok: info.independent ? !info.hasImportLine && !info.hasReadStep : injected,
        partial,
      };
    });
}

/**
 * 레지스트리 감사와 서브에이전트 감사를 합쳐 위반 목록을 만든다.
 * 위반이 0개면 주입 체계가 선언대로 유지되고 있다는 뜻이다.
 */
function auditInjection({ projectDir, fsOverrides = {} }) {
  const registry = auditRegistry({ projectDir, fsOverrides });
  const agents = auditAgents({ projectDir, fsOverrides });
  const violations = [];

  for (const name of registry.orphans) {
    violations.push(`고아 지침: ${name} 이 .claude/context/index.md 에 등록되지 않았습니다`);
  }
  for (const entry of registry.missing) {
    violations.push(`끊어진 등록: index.md 의 @${entry} 가 가리키는 파일이 없습니다`);
  }
  for (const entry of registry.badPaths) {
    violations.push(
      `경로 오기: @${entry} 는 루트 기준입니다. index.md 기준 상대경로(파일 이름만)로 적어야 조용히 누락되지 않습니다`
    );
  }
  for (const agent of agents) {
    if (agent.ok) continue;
    if (agent.independent) {
      violations.push(
        `차단 위반: ${agent.name} 은 독립 판정 에이전트인데 지침 주입 표식이 있습니다 (컨텍스트 차단은 설계입니다 — OS.md 2026-08-28)`
      );
    } else if (agent.partial) {
      violations.push(
        `주입 불완전: ${agent.name} 에 ${agent.hasImportLine ? "읽기 지시" : "@import 줄"}가 없습니다 (둘 다 필요)`
      );
    } else {
      violations.push(`주입 누락: ${agent.name} 이 지침을 받지 않습니다`);
    }
  }

  return {
    ok: violations.length === 0,
    registry,
    agents,
    counts: {
      guidelines: registry.files.length,
      injectedAgents: agents.filter((a) => a.injected).length,
      blockedAgents: agents.filter((a) => a.independent).length,
    },
    violations,
  };
}

module.exports = { listGuidelineFiles, auditRegistry, inspectAgent, auditAgents, auditInjection, INDEPENDENCE_MARKER };
