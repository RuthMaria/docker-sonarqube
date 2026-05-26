import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";

// Token de acesso pessoal do GitHub. A API /search/commits exige autenticação.
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Defina GITHUB_TOKEN no ambiente.");
  console.error('PowerShell:  $env:GITHUB_TOKEN = "ghp_xxx"');
  console.error('Bash:        export GITHUB_TOKEN="ghp_xxx"');
  process.exit(1);
}

// Instância do cliente Octokit para fazer requisições à API do GitHub.
const octokit = new Octokit({ auth: token });

// Cada agente de IA deixa uma "assinatura" identificável nos commits que faz.
// Usamos essas queries para localizar commits autorados por IA via Search API.
const AI_SIGNATURES = [
  { name: "aider", query: '"aider: " in:message' },
  { name: "claude-code", query: '"Co-Authored-By: Claude"' },
  { name: "copilot-agent", query: '"Co-Authored-By: Copilot"' },
  { name: "devin", query: "author:devin-ai-integration[bot]" },
];

// Limites de filtragem. Afrouxados para uma primeira passada exploratória.
const MIN_AI_COMMITS = 2; // mínimo de commits de IA no mesmo repo
const MIN_REPO_AGE_DAYS = 180; // idade mínima do repo (6 meses)
const MAX_PAGES_PER_SIGNATURE = 2; // até 200 commits amostrados por agente

type RepoStats = {
  fullName: string;
  url: string;
  language: string | null;
  ageDays: number;
  stars: number;
  aiCommitsBySignature: Record<string, number>;
  totalAiCommits: number;
};

// Faz uma requisição com retry em caso de 403 (secondary rate limit).
// Respeita o header `retry-after` quando presente; senão usa backoff exponencial.
type SearchCommitsParams = {
  q: string;
  per_page: number;
  page: number;
  sort: "author-date" | "committer-date";
  order: "asc" | "desc";
};

async function requestWithRetry(
  params: SearchCommitsParams,
  maxRetries = 3,
): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await octokit.request("GET /search/commits", params);
    } catch (err: any) {
      const status = err.status;
      const isRateLimit =
        status === 403 && /rate limit/i.test(err.message ?? "");

      if (!isRateLimit || attempt >= maxRetries) {
        throw err;
      }

      // GitHub manda `retry-after` em segundos quando estoura limite secundário.
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const waitSec =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : 60 * Math.pow(2, attempt); // 60s, 120s, 240s...

      console.warn(
        `  ⚠ rate limit atingido. Aguardando ${waitSec}s antes de tentar de novo (tentativa ${attempt + 1}/${maxRetries})...`,
      );
      await sleep(waitSec * 1000);
      attempt++;
    }
  }
}

// Etapa 1 — para uma dada assinatura, pagina /search/commits e devolve a lista
// de repositórios onde os commits apareceram (com repetição: 1 entrada por commit).
async function searchCommitsBySignature(query: string): Promise<string[]> {
  const repos: string[] = [];

  for (let page = 1; page <= MAX_PAGES_PER_SIGNATURE; page++) {
    try {
      const res = await requestWithRetry({
        q: query,
        per_page: 100,
        page,
        sort: "committer-date",
        order: "desc",
      });

      const items = res.data.items ?? [];
      if (items.length === 0) {
        break;
      }

      for (const item of items) {
        if (item.repository?.full_name) {
          repos.push(item.repository.full_name);
        }
      }

      console.log(`Página ${page}: ${items.length} commits encontrados`);
      // Última página tem menos de 100 → não precisa pedir a próxima.
      if (items.length < 100) {
        break;
      }

      // Pausa entre páginas para evitar o secondary rate limit da Search API.
      await sleep(8000);
    } catch (err: any) {
      console.error(`  ! erro na pagina ${page}: ${err.message}`);
      break;
    }
  }

  return repos;
}

// Etapa 3 — busca metadados do repositório (linguagem, estrelas, data de criação)
// para aplicar os filtros de qualidade e enriquecer o resultado final.
async function getRepoMeta(fullName: string) {
  const [owner, repo] = fullName.split("/");
  const { data } = await octokit.repos.get({ owner, repo });
  const ageDays = Math.floor(
    (Date.now() - new Date(data.created_at).getTime()) / 86400000,
  );

  return {
    language: data.language,
    stars: data.stargazers_count,
    ageDays,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Buscando commits com assinatura de IA...\n");

  // Mapa: full_name do repo → { aider: N, claude-code: M, ... }
  const repoToCounts = new Map<string, Record<string, number>>();
  // Estatísticas por assinatura para diagnóstico.
  const statsBySig: Record<string, { commits: number; repos: number }> = {};

  // Etapa 2 — para cada agente de IA, busca commits e agrega contagens por repo.
  for (const sig of AI_SIGNATURES) {
    console.log(`[${sig.name}] query: ${sig.query}`);
    const repoNames = await searchCommitsBySignature(sig.query);
    const uniqueRepos = new Set(repoNames);
    statsBySig[sig.name] = {
      commits: repoNames.length,
      repos: uniqueRepos.size,
    };
    console.log(
      `${repoNames.length} commits em ${uniqueRepos.size} repositórios únicos`,
    );
    console.log(`------------------------------------------------------`);

    // Agrega contagens por repo. Se um repo apareceu em múltiplas páginas, soma as ocorrências.
    for (const fullName of repoNames) {
      const counts = repoToCounts.get(fullName) ?? {};
      counts[sig.name] = (counts[sig.name] ?? 0) + 1;
      repoToCounts.set(fullName, counts);
    }
    // Pausa entre assinaturas para respeitar o rate limit da Search API.
    await sleep(3000);
  }

  console.log(`\n=== Diagnóstico ===`);
  for (const [name, s] of Object.entries(statsBySig)) {
    console.log(`  ${name}: ${s.commits} commits / ${s.repos} repos`);
  }
  console.log(`Total de repos únicos: ${repoToCounts.size}`);

  // Etapa 4 — aplica filtros: volume mínimo de commits de IA e idade mínima.
  // Conta também quantos repos caem em cada peneira para entender a perda.
  let cutByCommits = 0;
  let cutByAge = 0;
  let cutByError = 0;

  console.log(
    `\nFiltrando (mín ${MIN_AI_COMMITS} commits IA, idade ≥ ${MIN_REPO_AGE_DAYS}d)...\n`,
  );

  const results: RepoStats[] = [];
  for (const [fullName, counts] of repoToCounts) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    if (total < MIN_AI_COMMITS) {
      cutByCommits++;
      continue;
    }

    try {
      const meta = await getRepoMeta(fullName);
      if (meta.ageDays < MIN_REPO_AGE_DAYS) {
        cutByAge++;
        continue;
      }

      results.push({
        fullName,
        url: `https://github.com/${fullName}`,
        language: meta.language,
        ageDays: meta.ageDays,
        stars: meta.stars,
        aiCommitsBySignature: counts,
        totalAiCommits: total,
      });
      console.log(
        `  + ${fullName} (${total} commits IA, ${meta.ageDays}d, ${meta.language})`,
      );
      await sleep(500);
    } catch (err: any) {
      cutByError++;
      console.error(`  ! ${fullName}: ${err.message}`);
    }
  }

  console.log(`\n=== Filtragem ===`);
  console.log(`  Cortados por < ${MIN_AI_COMMITS} commits: ${cutByCommits}`);
  console.log(`  Cortados por idade < ${MIN_REPO_AGE_DAYS}d: ${cutByAge}`);
  console.log(`  Erros ao buscar metadados: ${cutByError}`);
  console.log(`  Aprovados: ${results.length}`);

  // Etapa 5 — ordena pelos repos com mais commits de IA e grava o JSON final.
  results.sort((a, b) => b.totalAiCommits - a.totalAiCommits);

  writeFileSync("candidates.json", JSON.stringify(results, null, 2));
  console.log(`\nSalvo em candidates.json — ${results.length} candidatos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
