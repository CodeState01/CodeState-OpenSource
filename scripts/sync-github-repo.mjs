import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [repo, mode = 'source', readmePath] = process.argv.slice(2);
if (!repo) throw new Error('Uso: node scripts/sync-github-repo.mjs owner/repo [source|readme] [arquivo]');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

function command(program, args, input) {
  const result = spawnSync(program, args, { encoding: 'utf8', input, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${program} falhou`);
  return result.stdout.trim();
}

function api(path, method = 'GET', payload) {
  const args = ['api', path];
  if (method !== 'GET') args.push('-X', method);
  if (payload !== undefined) args.push('--input', '-');
  const output = command('gh', args, payload === undefined ? undefined : JSON.stringify(payload));
  return output ? JSON.parse(output) : {};
}

const ref = api(`/repos/${repo}/git/ref/heads/main`);
const parent = ref.object.sha;
const previous = api(`/repos/${repo}/git/commits/${parent}`);
let files;
if (mode === 'readme') {
  if (!readmePath) throw new Error('Informe o arquivo README público.');
  files = [{ path: 'README.md', mode: '100644', bytes: readFileSync(readmePath) }];
} else {
  files = command('git', ['ls-files', '-s']).split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^(\d+) [0-9a-f]+ \d+\t(.+)$/);
    if (!match) throw new Error(`Entrada Git inválida: ${line}`);
    return { path: match[2].replaceAll('\\', '/'), mode: match[1], bytes: readFileSync(match[2]) };
  });
}

const tree = [];
for (const file of files) {
  const blob = api(`/repos/${repo}/git/blobs`, 'POST', { content: file.bytes.toString('base64'), encoding: 'base64' });
  tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
  process.stdout.write(`Enviado: ${file.path}\n`);
}
const createdTree = api(`/repos/${repo}/git/trees`, 'POST', mode === 'readme' ? { tree } : { base_tree: previous.tree.sha, tree });
const commit = api(`/repos/${repo}/git/commits`, 'POST', { message: mode === 'readme' ? 'docs: keep public repository download-only' : `release: CodeState ${version}`, tree: createdTree.sha, parents: mode === 'readme' ? [] : [parent] });
api(`/repos/${repo}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: mode === 'readme' });
process.stdout.write(`Atualizado ${repo}: ${commit.sha}\n`);
