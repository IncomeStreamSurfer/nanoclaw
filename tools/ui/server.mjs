// NanoClaw UI — a thin local web face over the `ncl` control plane.
// Localhost-only by design: this is the admin plane (mounts, channels, agents).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NCL = path.join(ROOT, 'bin', 'ncl');
const PORT = Number(process.env.NANOCLAW_UI_PORT || 7799);

function ncl(args) {
  return new Promise((resolve) => {
    execFile(NCL, [...args, '--json'], { cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) => {
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.ok === false ? { ok: false, error: parsed.error || stderr || String(err) } : { ok: true, data: parsed.data ?? parsed });
      } catch {
        resolve(err ? { ok: false, error: (stderr || stdout || String(err)).trim() } : { ok: true, data: stdout.trim() });
      }
    });
  });
}

const PROVIDERS = ['claude', 'codex', 'ollama'];

// OneCLI vault — secrets stored here are injected by the gateway proxy into
// requests to their host pattern; the agent never sees the value.
// The OneCLI CLI resolves its own default project from its auth; only pass
// --project when an operator deliberately overrides it.
const ONECLI_PROJECT = process.env.NANOCLAW_UI_ONECLI_PROJECT || '';
const projArgs = ONECLI_PROJECT ? ['--project', ONECLI_PROJECT] : [];
const ONECLI_BIN = process.env.NANOCLAW_UI_ONECLI_BIN || 'onecli';
function vault(args) {
  return new Promise((resolve) => {
    execFile(ONECLI_BIN, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      try { const d = JSON.parse(stdout); resolve(d.error ? { ok: false, error: d.error } : { ok: true, data: d.data ?? d }); }
      catch { resolve(err ? { ok: false, error: (stderr || stdout || String(err)).trim() } : { ok: true, data: stdout.trim() }); }
    });
  });
}
async function vaultCreate(botFolder, key, value, host, inject, param) {
  const args = ['secrets', 'create', ...projArgs, '--name', `${botFolder}:${key}`,
    '--type', 'generic', '--host-pattern', host, '--path-pattern', '/*', '--value', value];
  if (inject === 'param') args.push('--param-name', param || key.toLowerCase());
  else args.push('--header-name', 'Authorization', '--value-format', 'Bearer {value}');
  return vault(args);
}
async function vaultListFor(botFolder) {
  const r = await vault(['secrets', 'list', ...projArgs]);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.filter(s => s.name?.startsWith(`${botFolder}:`)).map(s => ({ id: s.id, key: s.name.slice(botFolder.length + 1), host: s.hostPattern }));
}

async function getState() {
  // A checkout with no NanoClaw install has no host socket — say so plainly
  // instead of letting every call fail with a confusing CLI error.
  const hostReady = fs.existsSync(path.join(ROOT, 'data', 'ncl.sock'));
  if (!hostReady) {
    return { hostReady: false, groups: [], wirings: [], messagingGroups: [], tasks: [],
      groupConfigs: {}, providers: PROVIDERS, templates: [], channels: { discord: { installed: false } },
      stats: { runsToday: 0, failedToday: 0, vaultKeys: 0, nextRunMs: null } };
  }
  const [groups, wirings, messagingGroups, tasks] = await Promise.all([
    ncl(['groups', 'list']),
    ncl(['wirings', 'list']),
    ncl(['messaging-groups', 'list']),
    ncl(['tasks', 'list']),
  ]);
  const groupConfigs = {};
  for (const g of groups.data || []) {
    const cfg = await ncl(['groups', 'config', 'get', '--id', g.id]);
    groupConfigs[g.id] = cfg.data || {};
  }
  // `tasks list` omits run counts — enrich from each series' detail.
  const taskList = tasks.data || [];
  for (const t of taskList) {
    const id = t.series_id || t.id;
    if (!id || String(id).startsWith('ui-')) continue;
    const d = await ncl(['tasks', 'get', String(id)]);
    if (d.ok && d.data) {
      t.completed_runs = d.data.completed_runs ?? t.completed_runs;
      t.failed_runs = d.data.failed_runs ?? t.failed_runs;
      t.last_result = (d.data.recent_log || []).slice(-1)[0] || null;
    }
  }
  const discordInstalled = fs.existsSync(path.join(ROOT, 'src', 'channels', 'discord.ts'));
  const templates = [];
  const tplDir = path.join(ROOT, 'templates');
  const walk = (dir, ref) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      const r = ref ? `${ref}/${e.name}` : e.name;
      if (fs.existsSync(path.join(sub, 'plugin.json'))) templates.push(r);
      else walk(sub, r);
    }
  };
  if (fs.existsSync(tplDir)) walk(tplDir, '');

  // Dashboard stats, from what the host actually knows.
  const today = new Date().toISOString().slice(0, 10);
  let runsToday = 0, failedToday = 0;
  const groupsDir = path.join(ROOT, 'groups');
  if (fs.existsSync(groupsDir)) {
    for (const g of fs.readdirSync(groupsDir)) {
      const tDir = path.join(groupsDir, g, 'tasks');
      if (!fs.existsSync(tDir)) continue;
      for (const f of fs.readdirSync(tDir)) {
        if (!f.endsWith('.md')) continue;
        for (const line of fs.readFileSync(path.join(tDir, f), 'utf8').split('\n')) {
          if (!line.startsWith(today)) continue;
          runsToday++;
          if (/failed to authenticate|error:|failed:/i.test(line)) failedToday++;
        }
      }
    }
  }
  const vaultAll = await vault(['secrets', 'list', ...projArgs]);
  const vaultKeys = Array.isArray(vaultAll.data) ? vaultAll.data.length : 0;
  const upcoming = (tasks.data || [])
    .map(t => t.process_after && Date.parse(t.process_after.replace(' ', 'T') + (t.process_after.endsWith('Z') ? '' : 'Z')))
    .filter(n => n && n > Date.now()).sort((a, b) => a - b);
  const nextRunMs = upcoming.length ? upcoming[0] - Date.now() : null;

  return {
    hostReady: true,
    groups: groups.data || [], wirings: wirings.data || [], messagingGroups: messagingGroups.data || [],
    tasks: taskList, groupConfigs, providers: PROVIDERS, templates,
    channels: { discord: { installed: discordInstalled } },
    stats: { runsToday, failedToday, vaultKeys, nextRunMs },
  };
}

// ── Updating NanoClaw itself ───────────────────────────────────────────────
// Routine updates only. A release with [BREAKING] entries needs the project's
// own /update-nanoclaw skill (staged worktree, migration gates, rollback), so
// this refuses to apply one silently.
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, timeout: opts.timeout || 300_000, maxBuffer: 8 << 20, env: { ...process.env, HUSKY: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '') + (stderr || ''), code: err?.code ?? 0 }));
  });
}
const upstreamRemote = async () => {
  const r = await sh('git', ['remote', '-v']);
  const names = new Set(r.out.split('\n').map(l => l.split(/\s+/)[0]).filter(Boolean));
  if (names.has('upstream')) return 'upstream';
  const origin = await sh('git', ['remote', 'get-url', 'origin']);
  if (/nanocoai\/nanoclaw/.test(origin.out)) return 'origin';
  return names.has('origin') ? 'origin' : [...names][0];
};
let updateJob = null; // { running, steps:[{name,state,detail}], startedAt, rollback }

async function updateCheck() {
  const remote = await upstreamRemote();
  await sh('git', ['fetch', remote, 'main', '--quiet'], { timeout: 120_000 });
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const latestPkg = await sh('git', ['show', `${remote}/main:package.json`]);
  let latest = current;
  try { latest = JSON.parse(latestPkg.out).version; } catch {}
  const behind = Number((await sh('git', ['rev-list', '--count', `HEAD..${remote}/main`])).out.trim()) || 0;
  const dirty = (await sh('git', ['status', '--porcelain'])).out.trim();
  const containerChanged = !!(await sh('git', ['diff', '--name-only', 'HEAD', `${remote}/main`, '--', 'container/'])).out.trim();
  // Any [BREAKING] line in the changelog that is new to us.
  const chDiff = await sh('git', ['diff', `HEAD..${remote}/main`, '--', 'CHANGELOG.md']);
  const breaking = chDiff.out.split('\n')
    .filter(l => l.startsWith('+') && /\[BREAKING\]/.test(l))
    .map(l => l.replace(/^\+\s*-?\s*/, '').replace(/\[BREAKING\]\s*/, '').replace(/\*\*/g, '').slice(0, 220));
  return { remote, current, latest, behind, dirty: dirty ? dirty.split('\n').length : 0, containerChanged, breaking, upToDate: behind === 0 };
}

async function updateApply(force) {
  const info = await updateCheck();
  if (info.upToDate) return { ok: false, error: 'Already up to date.' };
  if (info.dirty) return { ok: false, error: `${info.dirty} uncommitted change(s) — commit or stash them first.` };
  if (info.breaking.length && !force) return { ok: false, error: 'breaking', breaking: info.breaking };

  const steps = [];
  const step = (name) => { const s = { name, state: 'running', detail: '' }; steps.push(s); return s; };
  const tag = `ui-update-rollback-${Date.now()}`;
  updateJob = { running: true, steps, startedAt: Date.now(), rollback: tag, to: info.latest };

  (async () => {
    let s = step('Saving a rollback point');
    const t = await sh('git', ['tag', '-f', tag]);
    s.state = t.ok ? 'done' : 'failed'; s.detail = t.ok ? tag : t.out.slice(-200);
    if (!t.ok) { updateJob.running = false; return; }

    s = step(`Merging ${info.remote}/main`);
    const m = await sh('git', ['-c', 'core.hooksPath=/dev/null', 'merge', `${info.remote}/main`, '-m', 'Update NanoClaw from upstream (via UI)']);
    s.state = m.ok ? 'done' : 'failed'; s.detail = m.out.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    if (!m.ok) { await sh('git', ['merge', '--abort']); updateJob.running = false; updateJob.failed = 'merge conflict — resolve it in a terminal'; return; }

    s = step('Installing dependencies');
    const i = await sh('pnpm', ['install', '--frozen-lockfile'], { timeout: 600_000 });
    s.state = i.ok ? 'done' : 'failed'; s.detail = i.out.trim().split('\n').slice(-2).join(' ').slice(0, 300);

    s = step('Building');
    const b = await sh('pnpm', ['run', 'build'], { timeout: 600_000 });
    s.state = b.ok ? 'done' : 'failed'; s.detail = b.out.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    if (!b.ok) {
      const r = step('Build failed — rolling back');
      const rb = await sh('git', ['reset', '--hard', tag], { timeout: 120_000 });
      await sh('pnpm', ['install', '--frozen-lockfile'], { timeout: 600_000 });
      r.state = rb.ok ? 'done' : 'failed'; r.detail = rb.ok ? `restored ${tag}` : rb.out.slice(-200);
      updateJob.running = false; updateJob.failed = 'build failed; rolled back'; return;
    }

    if (info.containerChanged) {
      s = step('Rebuilding the agent sandbox (slow)');
      const c = await sh('bash', ['container/build.sh'], { timeout: 1_800_000 });
      s.state = c.ok ? 'done' : 'failed'; s.detail = c.out.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    }

    s = step('Restarting NanoClaw');
    const rs = await sh('bash', ['setup/lib/restart.sh'], { timeout: 180_000 });
    s.state = rs.ok ? 'done' : 'failed'; s.detail = rs.out.trim().split('\n').slice(-2).join(' ').slice(0, 200);

    s = step('Verifying');
    let healthy = false;
    for (let n = 0; n < 12 && !healthy; n++) {
      await new Promise(r => setTimeout(r, 2500));
      healthy = (await ncl(['groups', 'list'])).ok;
    }
    s.state = healthy ? 'done' : 'failed';
    s.detail = healthy ? `now on v${info.latest}` : 'host did not come back — check logs/nanoclaw.error.log';
    updateJob.running = false;
    if (!healthy) updateJob.failed = 'host did not come back';
  })().catch(e => { updateJob.running = false; updateJob.failed = String(e.message || e); });

  return { ok: true, data: { started: true, to: info.latest, rollback: tag } };
}

async function handleApi(req, res, url, body) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const parts = url.pathname.split('/').filter(Boolean); // api, ...
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, await getState());

    if (req.method === 'GET' && url.pathname === '/api/update/check') return send(200, { ok: true, data: await updateCheck() });
    if (req.method === 'GET' && url.pathname === '/api/update/status') return send(200, { ok: true, data: updateJob });
    if (req.method === 'POST' && url.pathname === '/api/update/apply') {
      if (updateJob?.running) return send(409, { ok: false, error: 'An update is already running.' });
      return send(200, await updateApply(!!body.force));
    }

    if (req.method === 'POST' && url.pathname === '/api/agents') {
      const { name, provider, template } = body;
      if (!name) return send(400, { ok: false, error: 'name required' });
      // Folder must satisfy the runtime label grammar: [A-Za-z0-9_-], alnum ends, <=63.
      const folder = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 63);
      if (!folder) return send(400, { ok: false, error: 'name must contain letters or numbers' });
      const args = ['groups', 'create', '--name', name, '--folder', folder];
      if (template) args.push('--template', template, '--new');
      const created = await ncl(args);
      if (!created.ok) return send(500, created);
      const id = created.data?.id;
      if (id && provider && PROVIDERS.includes(provider)) await ncl(['groups', 'config', 'update', '--id', id, '--provider', provider]);
      return send(200, { ok: true, data: created.data });
    }

    // ── Serve an image a run referenced, from allowlisted roots only ───────
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const raw = url.searchParams.get('p') || '';
      const ext = path.extname(raw).toLowerCase();
      const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      if (!TYPES[ext]) return send(400, { ok: false, error: 'not an image path' });
      // Roots an agent can legitimately have written to.
      const roots = [path.join(ROOT, 'groups')];
      try {
        const allow = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.config', 'nanoclaw', 'mount-allowlist.json'), 'utf8'));
        for (const r of allow.allowedRoots || []) if (r.path) roots.push(path.resolve(r.path));
      } catch {}
      // Container paths map back to their host root; relative paths are tried under each.
      const rel = raw.replace(/^\/workspace\/(?:extra|group|project)\/[^/]*\/?/, '').replace(/^\/+/, '');
      const candidates = [];
      if (path.isAbsolute(raw)) candidates.push(path.resolve(raw));
      for (const r of roots) candidates.push(path.resolve(r, rel));
      for (const c of candidates) {
        const inRoot = roots.some(r => c === r || c.startsWith(r + path.sep));
        if (!inRoot || !fs.existsSync(c) || !fs.statSync(c).isFile()) continue;
        res.writeHead(200, { 'content-type': TYPES[ext], 'cache-control': 'max-age=300' });
        return res.end(fs.readFileSync(c));
      }
      return send(404, { ok: false, error: 'not found in an allowed root' });
    }

    // ── Runs feed: every run entry across every bot, newest first ──────────
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const groupsDir = path.join(ROOT, 'groups');
      const wantBot = url.searchParams.get('bot') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 150, 500);
      const groupNames = {};
      for (const g of (await ncl(['groups', 'list'])).data || []) groupNames[g.folder] = { name: g.name, id: g.id };
      const runs = [];
      if (fs.existsSync(groupsDir)) {
        for (const folder of fs.readdirSync(groupsDir)) {
          if (wantBot && folder !== wantBot) continue;
          const tDir = path.join(groupsDir, folder, 'tasks');
          if (!fs.existsSync(tDir)) continue;
          for (const file of fs.readdirSync(tDir)) {
            if (!file.endsWith('.md')) continue;
            const series = file.replace(/\.md$/, '');
            const lines = fs.readFileSync(path.join(tDir, file), 'utf8').split('\n');
            let cur = null;
            for (const line of lines) {
              const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+—\s+([\s\S]*)$/);
              if (m) {
                if (cur) runs.push(cur);
                cur = {
                  bot: groupNames[folder]?.name || folder, botFolder: folder, botId: groupNames[folder]?.id || null,
                  series, kind: series.startsWith('ui-ask') ? 'ask' : series.startsWith('ui-run') ? 'run' : 'scheduled',
                  ts: m[1], text: m[2],
                };
              } else if (cur && line.trim()) cur.text += '\n' + line;
            }
            if (cur) runs.push(cur);
          }
        }
      }
      for (const r of runs) {
        r.failed = /failed to authenticate|^error:|api error:|\bfailed:/i.test(r.text);
        r.quiet = /nothing cleared the bar|no qualifying idea|nothing qualified|sent no message|silently/i.test(r.text);
      }
      runs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      return send(200, { ok: true, data: runs.slice(0, limit), total: runs.length });
    }

    if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'history') {
      const series = parts[2].replace(/[^A-Za-z0-9_-]/g, '');
      const groupsDir = path.join(ROOT, 'groups');
      for (const g of fs.readdirSync(groupsDir)) {
        const f = path.join(groupsDir, g, 'tasks', `${series}.md`);
        if (fs.existsSync(f)) return send(200, { ok: true, data: fs.readFileSync(f, 'utf8') });
      }
      return send(404, { ok: false, error: 'no run log found' });
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'provider') {
      const { provider } = body;
      if (!PROVIDERS.includes(provider)) return send(400, { ok: false, error: 'unknown provider' });
      const upd = await ncl(['groups', 'config', 'update', '--id', parts[2], '--provider', provider]);
      if (!upd.ok) return send(500, upd);
      await ncl(['groups', 'restart', '--id', parts[2]]);
      return send(200, upd);
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'restart')
      return send(200, await ncl(['groups', 'restart', '--id', parts[2]]));

    if (req.method === 'POST' && url.pathname === '/api/discord/wire') {
      const { guildId, channelId, agentGroupId, name } = body;
      if (!/^[0-9]{5,25}$/.test(guildId || '') || !/^[0-9]{5,25}$/.test(channelId || ''))
        return send(400, { ok: false, error: 'guildId and channelId must be numeric Discord IDs' });
      const pid = `discord:${guildId}:${channelId}`;
      const mg = await ncl(['messaging-groups', 'create', '--channel-type', 'discord', '--platform-id', pid, '--name', name || 'discord-channel']);
      if (!mg.ok && !/already|exists|unique/i.test(mg.error || '')) return send(500, mg);
      const w = await ncl(['wirings', 'create', '--channel-type', 'discord', '--platform-id', pid,
        '--agent-group-id', agentGroupId, '--engage-mode', 'pattern', '--engage-pattern', '.*']);
      return send(w.ok ? 200 : 500, w);
    }

    // ── Bot builder: description + secrets → configured agent ──────────────
    if (req.method === 'POST' && url.pathname === '/api/bots') {
      const { name, mission, env, schedule, cron } = body;
      if (!name?.trim() || !mission?.trim()) return send(400, { ok: false, error: 'name and mission required' });
      const folder = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 63);
      if (!folder) return send(400, { ok: false, error: 'name must contain letters or numbers' });
      const created = await ncl(['groups', 'create', '--name', name.trim(), '--folder', folder]);
      if (!created.ok) return send(500, created);
      const id = created.data?.id;
      const groupDir = path.join(ROOT, 'groups', folder);
      fs.mkdirSync(groupDir, { recursive: true });
      // Split entries: host-scoped keys → vault (proxy-injected, invisible to the
      // agent); plain settings → bot.env in the bot's workspace.
      const settings = [], vaulted = [];
      for (const e of env || []) {
        if (!e.key?.trim()) continue;
        if (e.host?.trim()) {
          const v = await vaultCreate(folder, e.key.trim(), e.value ?? '', e.host.trim(), e.inject, e.param);
          if (v.ok) vaulted.push({ key: e.key.trim(), host: e.host.trim() });
          else settings.push(e); // fall back visibly rather than dropping the key
        } else settings.push(e);
      }
      const envLines = settings.map(e => `${e.key.trim()}=${e.value ?? ''}`);
      if (envLines.length) fs.writeFileSync(path.join(groupDir, 'bot.env'), envLines.join('\n') + '\n', { mode: 0o600 });
      // Persona: the user's mission, wrapped so every spawn knows its job and where its keys live.
      const persona = [
        `# ${name.trim()}`, '',
        '## Your mission', mission.trim(), '',
        '## Operating rules',
        '- When asked to "run your mission", perform it once end-to-end, then reply with a concise report: what you did, what worked, what the result was. Include concrete outputs (links, filenames, numbers).',
        ...(vaulted.length ? [
          '- The following APIs are AUTO-AUTHENTICATED by a secure gateway — call them normally WITHOUT any API key; authentication is injected for you and you cannot see or need the key:',
          ...vaulted.map(v => `  - ${v.host} (${v.key})`),
          '- Never invent, guess, or hardcode API keys for those hosts. If a request to them fails with 401, report it — do not try to add a key.',
        ] : []),
        envLines.length
          ? '- Non-secret settings for your work are in `bot.env` in your workspace folder (usually /workspace/group/bot.env).'
          : (vaulted.length ? '' : '- You have no stored credentials yet. If the mission needs an API key, say exactly which one is missing instead of failing silently.'),
        '- If the mission is impossible or unsafe as described, say why and stop.',
      ].join('\n');
      fs.writeFileSync(path.join(groupDir, 'instructions.prepend.md'), persona + '\n');
      if (schedule && cron?.trim()) await ncl(['tasks', 'create', '--group', id, '--name', `${folder}-schedule`, '--recurrence', cron.trim(), '--prompt', 'Run your mission now, per your standing instructions, and report the result.']);
      return send(200, { ok: true, data: { id, folder } });
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'run') {
      const created = await ncl(['tasks', 'create', '--group', parts[2], '--name', 'ui-run',
        '--process-after', new Date(Date.now() + 2000).toISOString(),
        '--prompt', 'Run your mission now, once, end-to-end, per your standing instructions. Reply with a concise report of what you did and the result.']);
      if (!created.ok) return send(500, created);
      return send(200, { ok: true, data: { series: created.data?.series_id || created.data?.row_id } });
    }

    if (parts[1] === 'agents' && parts[3] === 'env') {
      const g = (await ncl(['groups', 'get', '--id', parts[2]])).data;
      if (!g?.folder) return send(404, { ok: false, error: 'agent not found' });
      const envPath = path.join(ROOT, 'groups', g.folder, 'bot.env');
      if (req.method === 'GET') {
        const keys = fs.existsSync(envPath)
          ? fs.readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('=')).map(l => l.split('=')[0])
          : [];
        const vaultKeys = await vaultListFor(g.folder);
        return send(200, { ok: true, data: { settings: keys, vault: vaultKeys } });
      }
      if (req.method === 'POST') {
        const { key, value, host, inject, param, removeVaultId } = body;
        if (removeVaultId) return send(200, await vault(['secrets', 'delete', '--id', String(removeVaultId)]));
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key || '')) return send(400, { ok: false, error: 'invalid key name' });
        if (host?.trim()) {
          const existing = (await vaultListFor(g.folder)).find(v => v.key === key);
          if (existing) await vault(['secrets', 'delete', '--id', existing.id]);
          return send(200, await vaultCreate(g.folder, key, value ?? '', host.trim(), inject, param));
        }
        const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n').filter(Boolean) : [];
        const kept = lines.filter(l => !l.startsWith(key + '='));
        if (value !== null && value !== undefined && value !== '') kept.push(`${key}=${value}`);
        fs.writeFileSync(envPath, kept.join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
        return send(200, { ok: true });
      }
    }

    // ── Per-bot skills: GitHub URL or uploaded zip → agent skills overlay ──
    if (parts[1] === 'agents' && parts[3] === 'skills') {
      const overlay = path.join(ROOT, 'data', 'v2-sessions', parts[2], '.claude-shared', 'skills');
      if (req.method === 'GET') {
        const list = fs.existsSync(overlay)
          ? fs.readdirSync(overlay, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
          : [];
        return send(200, { ok: true, data: list });
      }
      if (req.method === 'DELETE' || (req.method === 'POST' && body.remove)) {
        const name = String(body.remove || body.name || '').replace(/[^A-Za-z0-9._-]/g, '');
        if (!name) return send(400, { ok: false, error: 'skill name required' });
        fs.rmSync(path.join(overlay, name), { recursive: true, force: true });
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && body.githubUrl) {
        const m = String(body.githubUrl).trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([\w.\/-]+))?\/?$/);
        if (!m) return send(400, { ok: false, error: 'not a github.com repository URL' });
        const [, owner, repo, ref] = m;
        const tmp = fs.mkdtempSync(path.join(ROOT, 'data', 'skill-dl-'));
        try {
          const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref ? encodeURIComponent(ref.split('/')[0]) : 'HEAD'}`;
          const resp = await fetch(tarUrl);
          if (!resp.ok) return send(400, { ok: false, error: `GitHub fetch failed (${resp.status}) — is the repo public?` });
          fs.writeFileSync(path.join(tmp, 'skill.tgz'), Buffer.from(await resp.arrayBuffer()));
          await new Promise((res, rej) => execFile('tar', ['-xzf', 'skill.tgz'], { cwd: tmp }, (e) => e ? rej(e) : res()));
          // Find every folder containing a SKILL.md (root of repo counts too).
          const found = [];
          const scan = (dir, depth) => {
            if (depth > 4) return;
            if (fs.existsSync(path.join(dir, 'SKILL.md'))) { found.push(dir); return; }
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
          };
          for (const e of fs.readdirSync(tmp, { withFileTypes: true })) if (e.isDirectory()) scan(path.join(tmp, e.name), 0);
          if (!found.length) return send(400, { ok: false, error: 'no SKILL.md found in that repository' });
          fs.mkdirSync(overlay, { recursive: true });
          const installed = [];
          for (const dir of found) {
            const fm = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^name:\s*(.+)$/m);
            const name = (fm ? fm[1].trim() : path.basename(dir) === path.basename(found[0]) && found.length === 1 ? repo : path.basename(dir))
              .replace(/[^A-Za-z0-9._-]/g, '-').replace(/-skill$/, '') || repo;
            const dest = path.join(overlay, name);
            fs.rmSync(dest, { recursive: true, force: true });
            fs.cpSync(dir, dest, { recursive: true });
            installed.push(name);
          }
          await ncl(['groups', 'restart', '--id', parts[2]]);
          return send(200, { ok: true, data: installed });
        } catch (e) {
          return send(500, { ok: false, error: String(e.message || e) });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      if (req.method === 'POST' && body.zipBase64) {
        const tmp = fs.mkdtempSync(path.join(ROOT, 'data', 'skill-up-'));
        try {
          fs.writeFileSync(path.join(tmp, 'skill.zip'), Buffer.from(body.zipBase64, 'base64'));
          await new Promise((res, rej) => execFile('unzip', ['-q', 'skill.zip', '-d', 'x'], { cwd: tmp }, (e) => e ? rej(e) : res()));
          const found = [];
          const scan = (dir, depth) => {
            if (depth > 4) return;
            if (fs.existsSync(path.join(dir, 'SKILL.md'))) { found.push(dir); return; }
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
          };
          scan(path.join(tmp, 'x'), 0);
          if (!found.length) return send(400, { ok: false, error: 'no SKILL.md found in the zip' });
          fs.mkdirSync(overlay, { recursive: true });
          const installed = [];
          for (const dir of found) {
            const fm = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^name:\s*(.+)$/m);
            const name = (fm ? fm[1].trim() : path.basename(dir)).replace(/[^A-Za-z0-9._-]/g, '-') || 'skill';
            const dest = path.join(overlay, name);
            fs.rmSync(dest, { recursive: true, force: true });
            fs.cpSync(dir, dest, { recursive: true });
            installed.push(name);
          }
          await ncl(['groups', 'restart', '--id', parts[2]]);
          return send(200, { ok: true, data: installed });
        } catch (e) {
          return send(500, { ok: false, error: String(e.message || e) });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      return send(400, { ok: false, error: 'provide githubUrl, zipBase64, or remove' });
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'delete') {
      return send(200, await ncl(['groups', 'delete', '--id', parts[2]]));
    }

    if (req.method === 'GET' && parts[1] === 'agents' && parts[3] === 'mission') {
      const g = (await ncl(['groups', 'get', '--id', parts[2]])).data;
      const f = g?.folder && path.join(ROOT, 'groups', g.folder, 'instructions.prepend.md');
      return send(200, { ok: true, data: f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' });
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'ask') {
      const { prompt } = body;
      if (!prompt?.trim()) return send(400, { ok: false, error: 'prompt required' });
      const name = 'ui-ask';
      const created = await ncl(['tasks', 'create', '--group', parts[2], '--name', name,
        '--process-after', new Date(Date.now() + 2000).toISOString(), '--prompt', prompt]);
      if (!created.ok) return send(500, created);
      return send(200, { ok: true, data: { series: created.data?.series_id || created.data?.row_id } });
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'schedule') {
      const { prompt, cron, name } = body;
      if (!prompt?.trim() || !cron?.trim()) return send(400, { ok: false, error: 'prompt and cron required' });
      const args = ['tasks', 'create', '--group', parts[2], '--name', name?.trim() || 'ui-job', '--recurrence', cron, '--prompt', prompt];
      const created = await ncl(args);
      if (!created.ok && /recurrence|frequent|quota/i.test(JSON.stringify(created.error)))
        return send(400, { ok: false, error: 'Schedule too frequent (max 4 runs/day without an override). Use a wider cron like "0 9 * * *".' });
      return send(created.ok ? 200 : 500, created);
    }

    if (req.method === 'POST' && parts[1] === 'tasks' && ['pause', 'resume', 'run', 'cancel'].includes(parts[3]))
      return send(200, await ncl(['tasks', parts[3], parts[2]]));

    if (req.method === 'GET' && parts[1] === 'tasks' && parts[2])
      return send(200, await ncl(['tasks', 'get', parts[2]]));

    return send(404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(500, { ok: false, error: String(e) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = {}; }
    }
    return handleApi(req, res, url, body);
  }
  const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'));
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});

server.listen(PORT, '127.0.0.1', () => console.log(`NanoClaw UI → http://127.0.0.1:${PORT}`));
