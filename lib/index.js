// meow-memory-starmap — host 半：只读 meow-memory 的 memory.db，通过 typert RPC 暴露记忆图数据。
// 纯只读：绝不写库，Node 内置 node:sqlite 以 readOnly 打开（与 meow-memory 的 DatabaseSync 同款）。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'meow-memory-starmap';

const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
const DB_REL = '.dsh-meow/memory.db';

// DSH 注册过的工作区（workspace.json → tables.workspaces[].path），默认工作区排最前。
function knownWorkspaces() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const out = [];
  try {
    const doc = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
    const table = (doc && doc.tables && doc.tables.workspaces) || {};
    const defaultId = doc && doc.global && doc.global.defaultWorkspaceId;
    const ids = Object.keys(table);
    const order = defaultId && table[defaultId] ? [defaultId, ...ids.filter((id) => id !== defaultId)] : ids;
    for (const id of order) {
      const p = table[id] && table[id].path;
      if (typeof p === 'string' && p) out.push(p);
    }
  } catch { /* 没有 workspace.json 就跳过 */ }
  return out;
}

// 记忆库定位：不写死任何本机路径。
// 顺序：DSH_MEOW_DB（整份文件路径）→ DSH_MEOW_WORKSPACE / DSH_WORKSPACE → DSH 注册的工作区 → 当前目录向上 4 层。
export function dbCandidates() {
  const env = process.env;
  const out = [];
  if (env.DSH_MEOW_DB) out.push(env.DSH_MEOW_DB);
  for (const key of ['DSH_MEOW_WORKSPACE', 'DSH_WORKSPACE']) {
    if (env[key]) out.push(`${env[key]}/${DB_REL}`);
  }
  for (const ws of knownWorkspaces()) out.push(`${ws}/${DB_REL}`);
  let dir = process.cwd();
  for (let i = 0; i < 4 && dir; i += 1) {
    out.push(`${dir}/${DB_REL}`);
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return [...new Set(out.map((p) => p.replace(/\\/g, '/')))];
}

function findDb() {
  for (const p of dbCandidates()) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// 读全量记忆图：节点 = 记忆条目（含 keywords 解析），边在 client 端计算。
function readGraph() {
  const dbPath = findDb();
  if (!dbPath) {
    return {
      ok: false,
      error: 'memory.db not found — install meow-memory in this workspace, or set DSH_MEOW_DB / DSH_WORKSPACE',
      tried: dbCandidates(),
      nodes: [],
    };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, error: `open failed: ${err && err.message ? err.message : err}`, dbPath, nodes: [] };
  }
  try {
    const nodes = [];
    for (const level of LEVELS) {
      let rows;
      try {
        // 各层表字段不同（soul/user 无 project/corrected/goal 等），必须 SELECT *，
        // 统一列名 SELECT 会因缺列报错被跳过，导致返回空。
        rows = db.prepare(`SELECT * FROM ${level}`).all();
      } catch {
        continue;
      }
      for (const r of rows) {
        let keywords = [];
        try { keywords = JSON.parse(r.keywords || '[]'); } catch { keywords = []; }
        nodes.push({
          id: `${level}:${r.id}`,
          level,
          content: r.content || '',
          importance: typeof r.importance === 'number' ? r.importance : 0,
          keywords,
          status: r.status || 'active',
          project: r.project || null,
          subcategory: r.subcategory || null,
          goal: r.goal || null,
          corrected: r.corrected ? 1 : 0,
          session: r.source_session || null,
          createdAt: r.created_at || null,
          updatedAt: r.updated_at || null,
          lastAccessedAt: r.last_accessed_at || null,
        });
      }
    }
    return { ok: true, dbPath, nodes };
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

// service 必须带 typertRemote 绑定属性（service/serviceKey/namespace），
// 否则 client 端 validateBinding 会报 "no visible typertRemote binding"。
class MemoryGraphService {
  typertRemote = Object.freeze({ service: this, serviceKey: 'memoryGraph', namespace: 'memoryGraph' });
  getGraph() { return readGraph(); }
}
const service = new MemoryGraphService();

// typert 调用描述符：一个无参方法 getGraph，返回透传 JSON。
const graphCodec = { mode: 'strict', typeSymbol: 'meow-memory-starmap#Graph', create: () => ({ parse: (v) => v }) };
const DESCRIPTORS = [{
  id: 'meow-memory-starmap#memoryGraph/getGraph',
  service: 'memoryGraph',
  namespace: 'memoryGraph',
  method: 'getGraph',
  invocation: { kind: 'direct' },
  result: graphCodec,
  parameters: [],
}];

export function apply(root) {
  root.inject(['typert'], (ctx) => {
    ctx.provide('memoryGraph', service);
    ctx.typert.register({
      package: 'meow-memory-starmap',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: DESCRIPTORS,
    });
  });
}
