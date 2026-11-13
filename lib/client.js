// memory-starmap — client 半：3D 星图面板（纯 Canvas 2D 透视投影，不依赖 three.js）。
// 节点分布在三维球壳上，视角可拖拽旋转，力导向收敛后静止。
window.__ModuleLoader__.load({
  id: "memory-starmap",
  factory: (require) => {
    const modules = {
      "client/index.js": {
        imports: {},
        run(module, exports, require) {
          const { useState, useEffect, useRef, useMemo, createElement } = require("react");

          const name = "memory-starmap";
          const inject = ["slots", "locale", "remote"];

          const codec = (n) => ({ mode: "strict", typeSymbol: `meow-memory-starmap#${n}`, create: () => ({ parse: (v) => v }) });
          const DESCRIPTORS = [{
            id: "meow-memory-starmap#memoryGraph/getGraph",
            service: "memoryGraph",
            namespace: "memoryGraph",
            method: "getGraph",
            invocation: { kind: "direct" },
            result: codec("Graph"),
            parameters: [],
          }];
          const REMOTE = { package: "meow-memory-starmap", descriptors: DESCRIPTORS };

          const LEVEL_ORDER = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];
          const LEVEL_COLORS = {
            soul: "#a78bfa", user: "#f472b6", project: "#fbbf24", fact: "#34d399",
            lesson: "#60a5fa", topic: "#22d3ee", rules: "#f87171",
          };
          const LEVEL_NAMES = {
            soul: "灵魂", user: "用户", project: "项目", fact: "事实",
            lesson: "教训", topic: "话题", rules: "规则",
          };

          function radiusOf(n) {
            if (n.isVirtual) return 9 + Math.min(14, (n._count || 1) * 0.7);
            return 1.8 + (n.importance || 0) * 1.0;
          }
          function labelOf(n) {
            if (n.isVirtual) return n.content;
            const c = (n.content || "").trim().replace(/\s+/g, " ");
            return c.length > 14 ? c.slice(0, 14) + "…" : c;
          }
          function timefmt(ms) {
            if (!ms) return "";
            const d = new Date(ms);
            const p = (x) => String(x).padStart(2, "0");
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
          }

          function buildGraph(allNodes, hiddenLevels, search) {
            const nodes = allNodes.filter((n) => {
              if (n.status === "archived") return false;
              if (hiddenLevels.has(n.level)) return false;
              if (search) {
                const hay = ((n.content || "") + " " + (n.keywords || []).join(" ")).toLowerCase();
                if (!hay.includes(search.toLowerCase())) return false;
              }
              return true;
            });

            const projectCount = new Map();
            for (const n of nodes) if (n.project) projectCount.set(n.project, (projectCount.get(n.project) || 0) + 1);
            const virtuals = [];
            for (const [pname, cnt] of projectCount) {
              virtuals.push({
                id: "proj:" + pname, level: "project", content: pname, importance: Math.min(5, cnt),
                keywords: [], status: "active", isVirtual: true, _count: cnt,
              });
            }
            const all = [...virtuals, ...nodes];
            const idMap = new Map(all.map((n) => [n.id, n]));
            const links = [];

            for (const n of nodes) {
              if (!n.project) continue;
              const v = idMap.get("proj:" + n.project);
              if (v) links.push({ source: n, target: v, type: "project" });
            }

            const kwMap = new Map();
            for (const n of nodes) {
              if (!n.keywords || !n.keywords.length) continue;
              for (const kw of n.keywords) {
                if (!kwMap.has(kw)) kwMap.set(kw, []);
                kwMap.get(kw).push(n);
              }
            }
            const pairWeight = new Map();
            for (const [kw, list] of kwMap) {
              if (list.length < 2 || list.length > 120) continue;
              for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                  const a = list[i], b = list[j];
                  const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
                  pairWeight.set(key, (pairWeight.get(key) || 0) + 1);
                }
              }
            }
            const cand = [];
            for (const [key, w] of pairWeight) {
              if (w < 2) continue;
              const [aId, bId] = key.split("|");
              const a = idMap.get(aId), b = idMap.get(bId);
              if (a && b) cand.push({ a, b, w });
            }
            cand.sort((x, y) => y.w - x.w);
            const perNode = new Map();
            for (const e of cand) {
              const ca = perNode.get(e.a.id) || 0, cb = perNode.get(e.b.id) || 0;
              if (ca >= 4 || cb >= 4) continue;
              links.push({ source: e.a, target: e.b, type: "keyword", weight: e.w });
              perNode.set(e.a.id, ca + 1); perNode.set(e.b.id, cb + 1);
            }

            // 按 project 分组排序：同项目节点相邻，斐波那契球面分布时聚成团（无需力导向）
            const order = new Map();
            let oi = 0;
            for (const n of all) {
              const g = n.isVirtual ? n.content : (n.project || "__none__");
              if (!order.has(g)) order.set(g, oi++);
            }
            all.sort((a, b) => {
              const ga = order.get(a.isVirtual ? a.content : (a.project || "__none__"));
              const gb = order.get(b.isVirtual ? b.content : (b.project || "__none__"));
              return ga - gb;
            });
            return { nodes: all, links };
          }

          // 星系布局：项目节点（大球）在球面拉开距离，记忆节点（小球）围绕各自项目节点聚集
          function initSim(nodes, links, w, h) {
            const R = Math.min(w, h) * 0.42;
            const golden = Math.PI * (3 - Math.sqrt(5));
            const projectNodes = nodes.filter((n) => n.isVirtual);
            const memoryNodes = nodes.filter((n) => !n.isVirtual);
            const groupMap = new Map();
            for (const n of memoryNodes) {
              const g = n.project || "__none__";
              if (!groupMap.has(g)) groupMap.set(g, []);
              groupMap.get(g).push(n);
            }
            const simNodes = [];
            const projPos = new Map();

            // 1. 项目节点（大球）在球面均匀分布：星系之间距离远
            projectNodes.forEach((n, i) => {
              const t = (i + 0.5) / Math.max(1, projectNodes.length);
              const y = 1 - 2 * t;
              const rad = Math.sqrt(Math.max(0, 1 - y * y));
              const theta = golden * i;
              const pos = { x: Math.cos(theta) * rad * R, y: y * R, z: Math.sin(theta) * rad * R };
              projPos.set(n.id, pos);
              simNodes.push({ ...n, ...pos, vx: 0, vy: 0, vz: 0, r: radiusOf(n) });
            });

            // 随机球内偏移
            const rndOffset = (radius) => {
              const theta = Math.random() * Math.PI * 2;
              const phi = Math.acos(2 * Math.random() - 1);
              const rr = radius * (0.55 + Math.random() * 0.5);
              return { x: rr * Math.sin(phi) * Math.cos(theta), y: rr * Math.cos(phi), z: rr * Math.sin(phi) * Math.sin(theta) };
            };

            // 2. 记忆节点（小球）围绕所属项目节点聚集：恒星系
            for (const n of memoryNodes) {
              const g = n.project || "__none__";
              const center = projPos.get("proj:" + g);
              const groupSize = (groupMap.get(g) || []).length;
              if (n.level === "user") {
                // 用户节点：围绕中心点（球心）展开成中心星团
                const off = rndOffset(R * 0.34);
                simNodes.push({ ...n, x: off.x, y: off.y, z: off.z, vx: 0, vy: 0, vz: 0, r: radiusOf(n) });
              } else if (center) {
                // 恒星系半径：组越大稍大，但远小于星系间距
                const spread = Math.min(R * 0.4, 55 + Math.sqrt(groupSize) * 9);
                const off = rndOffset(spread);
                simNodes.push({ ...n, x: center.x + off.x, y: center.y + off.y, z: center.z + off.z, vx: 0, vy: 0, vz: 0, r: radiusOf(n) });
              } else {
                const off = rndOffset(R * 0.5);
                simNodes.push({ ...n, x: off.x, y: off.y, z: off.z, vx: 0, vy: 0, vz: 0, r: radiusOf(n) });
              }
            }

            const idToNode = new Map(simNodes.map((n) => [n.id, n]));
            const simLinks = links.map((l) => ({
              source: idToNode.get(l.source.id), target: idToNode.get(l.target.id),
              type: l.type, rest: l.type === "project" ? 25 : 40,
            })).filter((l) => l.source && l.target);
            // 纯静态布局，不跑力导向
            // 背景星场：远处星点，随视角旋转（立体星场，不是贴图）
            const backgroundStars = [];
            for (let i = 0; i < 140; i++) {
              const theta = Math.random() * Math.PI * 2;
              const phi = Math.acos(2 * Math.random() - 1);
              const rr = R * (1.6 + Math.random() * 2.6);
              backgroundStars.push({
                x: rr * Math.sin(phi) * Math.cos(theta),
                y: rr * Math.cos(phi),
                z: rr * Math.sin(phi) * Math.sin(theta),
                brightness: Math.random(),
              });
            }
            return { nodes: simNodes, links: simLinks, alpha: 0, R, backgroundStars };
          }

          // 3D 力导向，收敛后静止
          function tickSim(sim) {
            if (sim.alpha < 0.02) return;
            const { nodes, links, R } = sim;
            const repulsion = 26000, gravity = 0.012, damping = 0.88, stiffness = 0.006;
            for (let i = 0; i < nodes.length; i++) {
              const a = nodes[i];
              for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
                let d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > 60000) continue;
                if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = dx * dx + dy * dy + dz * dz; }
                const d = Math.sqrt(d2);
                const f = repulsion / d2;
                const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
                a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz;
              }
            }
            for (const l of links) {
              const s = l.source, t = l.target;
              let dx = t.x - s.x, dy = t.y - s.y, dz = t.z - s.z;
              let d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
              const f = (d - l.rest) * stiffness;
              const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
              s.vx += fx; s.vy += fy; s.vz += fz; t.vx -= fx; t.vy -= fy; t.vz -= fz;
            }
            const maxV = 8;
            for (const n of nodes) {
              // 拉向球壳半径 R，保持球形分布
              const cur = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) || 0.01;
              const pull = (R - cur) * gravity;
              n.vx += (n.x / cur) * pull; n.vy += (n.y / cur) * pull; n.vz += (n.z / cur) * pull;
              n.vx *= damping; n.vy *= damping; n.vz *= damping;
              if (n.vx > maxV) n.vx = maxV; else if (n.vx < -maxV) n.vx = -maxV;
              if (n.vy > maxV) n.vy = maxV; else if (n.vy < -maxV) n.vy = -maxV;
              if (n.vz > maxV) n.vz = maxV; else if (n.vz < -maxV) n.vz = -maxV;
              n.x += n.vx; n.y += n.vy; n.z += n.vz;
            }
            sim.alpha *= 0.98;
          }

          // 3D 旋转 + 透视投影
          function project3D(n, view, cx, cy) {
            // 相机目标点：锁定到某个项目/中心时，先平移让目标点归位
            const t = view.target || { x: 0, y: 0, z: 0 };
            const px = n.x - t.x, py = n.y - t.y, pz = n.z - t.z;
            const cosY = Math.cos(view.ry), sinY = Math.sin(view.ry);
            let x1 = px * cosY + pz * sinY;
            let z1 = -px * sinY + pz * cosY;
            const cosX = Math.cos(view.rx), sinX = Math.sin(view.rx);
            const y1 = py * cosX - z1 * sinX;
            const z2 = py * sinX + z1 * cosX;
            const focal = 900;
            const scale = view.zoom * focal / (focal + z2);
            return { sx: cx + x1 * scale, sy: cy - y1 * scale, z: z2, scale };
          }

          // 画一条边上的流星：亮点 + 渐窄拖尾
          function drawMeteor(ctx, sp, tp, isProjectEdge, period, travel, now, phase, zs) {
            const tInCycle = (now + phase) % period;
            if (tInCycle >= travel) return;
            const headT = tInCycle / travel;
            const tailSpan = 0.38;
            const tailStart = Math.max(0, headT - tailSpan);
            if (headT - tailStart > 0.002) {
              const dx = tp.sx - sp.sx, dy = tp.sy - sp.sy;
              const len = Math.hypot(dx, dy) || 1;
              const ux = dx / len, uy = dy / len;
              const nx = -uy, ny = ux;
              const hx = sp.sx + dx * headT, hy = sp.sy + dy * headT;
              const tx = sp.sx + dx * tailStart, ty = sp.sy + dy * tailStart;
              const headW = 1.6 * zs, tailW = 0.25 * zs;
              const tg = ctx.createLinearGradient(tx, ty, hx, hy);
              tg.addColorStop(0, isProjectEdge ? "rgba(255,248,200,0)" : "rgba(205,245,255,0)");
              tg.addColorStop(1, isProjectEdge ? "rgba(255,248,200,0.75)" : "rgba(205,245,255,0.75)");
              ctx.fillStyle = tg;
              ctx.beginPath();
              ctx.moveTo(hx + nx * headW, hy + ny * headW);
              ctx.lineTo(tx + nx * tailW, ty + ny * tailW);
              ctx.lineTo(tx - nx * tailW, ty - ny * tailW);
              ctx.lineTo(hx - nx * headW, hy - ny * headW);
              ctx.closePath();
              ctx.fill();
            }
            const px = sp.sx + (tp.sx - sp.sx) * headT;
            const py = sp.sy + (tp.sy - sp.sy) * headT;
            ctx.fillStyle = isProjectEdge ? "rgba(255,255,220,1)" : "rgba(220,250,255,1)";
            ctx.beginPath(); ctx.arc(px, py, Math.max(0.6, 1.6 * zs), 0, Math.PI * 2); ctx.fill();
          }

          function render(canvas, sim, view, hoverId, selectedId) {
            const ctx = canvas.getContext("2d");
            const w = canvas.clientWidth, h = canvas.clientHeight;
            const dpr = window.devicePixelRatio || 1;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
              canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const now = Date.now();
            const zs = Math.min(1, view.zoom);
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = "#05070f";
            ctx.fillRect(0, 0, w, h);
            const cx = w / 2, cy = h / 2;

            // 锁定某项目 + 筛选：只显示符合条件的节点（筛选不重排）
            const lockId = view.lockId;
            const lockProject = (lockId && lockId !== "__center__" && lockId !== "__user__")
              ? (sim.nodes.find((n) => n.id === lockId) || {}).content || null
              : null;
            const isUserLock = lockId === "__user__";
            const filter = view.filter || {};
            const isShown = (n) => {
              if (isUserLock) { if (n.level !== "user") return false; }
              else if (lockProject && !(n.id === lockId || (!n.isVirtual && n.project === lockProject))) return false;
              if (n.status === "archived") return false;
              if (filter.hiddenLevels && filter.hiddenLevels.has(n.level)) return false;
              if (filter.search) {
                const hay = ((n.content || "") + " " + (n.keywords || []).join(" ")).toLowerCase();
                if (!hay.includes(filter.search.toLowerCase())) return false;
              }
              return true;
            };
            const visibleIds = new Set();
            for (const n of sim.nodes) if (isShown(n)) visibleIds.add(n.id);

            // 投影所有节点
            const proj = sim.nodes.map((n) => {
              const p = project3D(n, view, cx, cy);
              return { n, ...p };
            });
            // 深度排序：远的先画
            proj.sort((a, b) => b.z - a.z);

            // 背景星场（3D，随视角旋转）
            if (sim.backgroundStars) {
              for (const s of sim.backgroundStars) {
                const bp = project3D(s, view, cx, cy);
                if (bp.z > 0) continue;
                const br = Math.max(0.3, 1.1 * bp.scale);
                ctx.globalAlpha = 0.12 + s.brightness * 0.3;
                ctx.fillStyle = "#9fb3d8";
                ctx.beginPath(); ctx.arc(bp.sx, bp.sy, br, 0, Math.PI * 2); ctx.fill();
              }
              ctx.globalAlpha = 1;
            }

            // 连线：普通边先画，选中节点的边最后画（高亮在上层）
            for (const l of sim.links) {
              if (visibleIds && (!visibleIds.has(l.source.id) || !visibleIds.has(l.target.id))) continue;
              if (selectedId && (l.source.id === selectedId || l.target.id === selectedId)) continue;
              const sp = project3D(l.source, view, cx, cy);
              const tp = project3D(l.target, view, cx, cy);
              ctx.strokeStyle = l.type === "project" ? "rgba(160,190,230,0.10)" : "rgba(130,160,210,0.06)";
              ctx.lineWidth = 0.5;
              ctx.beginPath();
              ctx.moveTo(sp.sx, sp.sy);
              ctx.lineTo(tp.sx, tp.sy);
              ctx.stroke();
              // 默认线的流星：每 300 秒出现一次
              let hh = 0;
              const kk = l.source.id + "|" + l.target.id;
              for (let i = 0; i < kk.length; i++) hh = (hh * 31 + kk.charCodeAt(i)) >>> 0;
              drawMeteor(ctx, sp, tp, l.type === "project", 300000, 500, now, hh % 300000, zs);
            }
            // 中心光效已按用户要求移除

            // 节点渲染：LOD——缩小聚合为项目星系光团，放大展开为单个星球
            const agg = Math.max(0, Math.min(1, (0.8 - view.zoom) / 0.4));
            for (const p of proj) {
              const n = p.n;
              if (visibleIds && !visibleIds.has(n.id)) continue;
              const color = LEVEL_COLORS[n.level] || "#cbd5e1";
              const isHot = n.id === selectedId || n.id === hoverId;

              if (n.isVirtual) {
                // 项目节点：展开时是发光星点，聚合时放大成星系光团（大小按记忆数）
                const countFactor = Math.min(4, Math.sqrt(n._count || 1) * 0.8);
                const boost = 1 + agg * (2 + countFactor);
                const r = Math.max(1.2, n.r * p.scale * boost);
                const t = Math.pow(1 - agg, 1.3);
                const isSel = n.id === selectedId;
                const glowR = r * (1.6 + (1 - t) * 1.2);
                const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, glowR);
                grad.addColorStop(0, "rgba(255,255,255,0.85)");
                grad.addColorStop(0.25, color + "aa");
                grad.addColorStop(0.6, color + "33");
                grad.addColorStop(1, color + "00");
                ctx.fillStyle = grad;
                ctx.beginPath(); ctx.arc(p.sx, p.sy, glowR, 0, Math.PI * 2); ctx.fill();
                // 近看清晰白核（放大→更实更大），远看渐隐成柔光；选中时更亮更大
                const coreA = isSel ? 1 : t * 0.98;
                if (coreA > 0.05) {
                  ctx.globalAlpha = coreA;
                  ctx.fillStyle = "rgba(255,255,255,0.98)";
                  ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(0.6, r * (0.3 + t * 0.2)), 0, Math.PI * 2); ctx.fill();
                  ctx.globalAlpha = 1;
                }
                // 标签：默认只悬停/选中显示，勾选「显示全部名字」才常显
                if (view.showAllLabels || n.id === selectedId || n.id === hoverId) {
                  const fs = Math.max(8, (11 + agg * 3) * p.scale);
                  ctx.fillStyle = "rgba(251,191,36,0.92)";
                  ctx.font = fs + 'px -apple-system, "Segoe UI", sans-serif';
                  ctx.textAlign = "center";
                  ctx.fillText(labelOf(n), p.sx, p.sy - Math.max(7, glowR * 0.9));
                }
              } else {
                // 记忆节点：聚合时渐隐，展开时正常显示
                const a = 1 - agg;
                if (a <= 0.06) continue;
                const r = Math.max(0.7, n.r * p.scale);
                const t = Math.pow(1 - agg, 1.3);
                const isSel = n.id === selectedId;
                const glowR = Math.max(r * (2.2 + (1 - t) * 2.3), isHot ? 16 : 4);
                const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, glowR);
                grad.addColorStop(0, "rgba(255,255,255,0.8)");
                grad.addColorStop(0.25, color + (isHot ? "dd" : "bb"));
                grad.addColorStop(0.6, color + "33");
                grad.addColorStop(1, color + "00");
                ctx.globalAlpha = a;
                ctx.fillStyle = grad;
                ctx.beginPath(); ctx.arc(p.sx, p.sy, glowR, 0, Math.PI * 2); ctx.fill();
                // 近看清晰白核（放大→更实更大），远看渐隐成柔光；选中时更亮更大
                const coreA = isSel ? 1 : t * 0.98;
                if (coreA > 0.05) {
                  ctx.globalAlpha = a * coreA;
                  ctx.fillStyle = "rgba(255,255,255,0.98)";
                  ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(0.5, r * (0.35 + t * 0.25)), 0, Math.PI * 2); ctx.fill();
                }
                ctx.globalAlpha = 1;
                if (view.showAllLabels || isHot) {
                  const fs = Math.max(7, 9 * p.scale);
                  ctx.fillStyle = "rgba(210,225,245,0.75)";
                  ctx.font = fs + 'px -apple-system, "Segoe UI", sans-serif';
                  ctx.textAlign = "center";
                  ctx.fillText(labelOf(n), p.sx, p.sy - Math.max(7, r * 2.2));
                }
              }
            }

            // 选中节点的连线最后画（最上层，不被节点光晕盖住）：外发光 + 亮核 + 流动光点
            if (selectedId) {
              const selNode = sim.nodes.find((n) => n.id === selectedId);
              const selIsProject = !!(selNode && selNode.isVirtual);
              const meteorTravel = 500;
              const meteorGap = selIsProject ? 59500 : 4500;
              const meteorPeriod = meteorTravel + meteorGap;
              for (const l of sim.links) {
                if (visibleIds && (!visibleIds.has(l.source.id) || !visibleIds.has(l.target.id))) continue;
                if (l.source.id !== selectedId && l.target.id !== selectedId) continue;
                // 每条边独立随机相位，流星各自流动（方向不变：源→目标）
                let h = 0;
                const key = l.source.id + "|" + l.target.id;
                for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
                const sp = project3D(l.source, view, cx, cy);
                const tp = project3D(l.target, view, cx, cy);
                const isProjectEdge = l.type === "project";
                ctx.strokeStyle = isProjectEdge ? "rgba(255,248,190,0.28)" : "rgba(170,235,255,0.28)";
                ctx.lineWidth = 0.5;
                ctx.beginPath(); ctx.moveTo(sp.sx, sp.sy); ctx.lineTo(tp.sx, tp.sy); ctx.stroke();
                // 流星：选中项目→60秒一次，选中其他→5秒一次
                const phase = h % meteorPeriod;
                drawMeteor(ctx, sp, tp, isProjectEdge, meteorPeriod, meteorTravel, now, phase, zs);
              }
            }
          }

          function hitTest(sim, view, sx, sy, w, h) {
            const cx = w / 2, cy = h / 2;
            const agg = Math.max(0, Math.min(1, (0.8 - view.zoom) / 0.4));
            let best = null, bestDist = 26 * 26;
            for (const n of sim.nodes) {
              if (agg > 0.5 && !n.isVirtual) continue; // 聚合时只命中项目节点
              const p = project3D(n, view, cx, cy);
              const r = Math.max(12, n.r * p.scale + 10);
              const dx = p.sx - sx, dy = p.sy - sy;
              const d2 = dx * dx + dy * dy;
              if (d2 <= r * r && d2 < bestDist) { best = n; bestDist = d2; }
            }
            return best;
          }

          function MemoryGraphPanel({ api }) {
            const canvasRef = useRef(null);
            const simRef = useRef(null);
            const viewRef = useRef({ rx: 0.38, ry: 0.0, zoom: 1, dragging: false, lastX: 0, lastY: 0, target: { x: 0, y: 0, z: 0 }, lockId: "__center__" });
            const hoverRef = useRef(null);
            const selectedRef = useRef(null);

            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [loading, setLoading] = useState(true);
            const [hiddenLevels, setHiddenLevels] = useState(new Set());
            const [search, setSearch] = useState("");
            const [selected, setSelected] = useState(null);
            const [lockTarget, setLockTarget] = useState("__center__");
            const [showAllLabels, setShowAllLabels] = useState(false);
            selectedRef.current = selected;
            viewRef.current.filter = { hiddenLevels, search };
            viewRef.current.showAllLabels = showAllLabels;

            useEffect(() => {
              let alive = true;
              (async () => {
                try {
                  const res = await api.getGraph();
                  if (!alive) return;
                  if (res && res.ok) {
                    const data = res.value;
                    if (data && data.ok) { setData(data); setError(null); }
                    else setError((data && data.error) || "unknown error");
                  } else {
                    setError((res && res.error && res.error.message) || "unknown error");
                  }
                } catch (e) {
                  if (alive) setError((e && e.message) || String(e));
                } finally {
                  if (alive) setLoading(false);
                }
              })();
              return () => { alive = false; };
            }, [api]);

            // 布局只用全量节点（筛选只影响显示，不触发重排）
            const graph = useMemo(() => (data ? buildGraph(data.nodes, new Set(), "") : null), [data]);

            const projectOptions = useMemo(() => {
              if (!graph) return [];
              return graph.nodes.filter((n) => n.isVirtual).map((n) => ({ id: n.id, name: n.content }));
            }, [graph]);

            const applyLock = (val) => {
              setLockTarget(val);
              const v = viewRef.current;
              v.lockId = val;
              if (val === "__center__" || val === "__user__") {
                v.target = { x: 0, y: 0, z: 0 };
              } else {
                const node = simRef.current && simRef.current.nodes.find((n) => n.id === val);
                if (node) v.target = { x: node.x, y: node.y, z: node.z };
              }
            };

            useEffect(() => {
              if (!graph) return;
              const c = canvasRef.current;
              const w = c ? c.clientWidth : 800, h = c ? c.clientHeight : 600;
              simRef.current = initSim(graph.nodes, graph.links, w, h);
              setSelected(null);
            }, [graph]);

            useEffect(() => {
              if (!graph) return;
              let raf;
              const loop = () => {
                const sim = simRef.current;
                if (sim) {
                  if (sim.alpha >= 0.02) tickSim(sim);
                  render(canvasRef.current, sim, viewRef.current, hoverRef.current, selectedRef.current ? selectedRef.current.id : null);
                }
                raf = requestAnimationFrame(loop);
              };
              raf = requestAnimationFrame(loop);
              return () => cancelAnimationFrame(raf);
            }, [graph]);

            useEffect(() => {
              const c = canvasRef.current;
              if (!c) return;
              const down = { moved: false, sx: 0, sy: 0 };
              const onDown = (e) => {
                const rect = c.getBoundingClientRect();
                down.moved = false; down.sx = e.clientX - rect.left; down.sy = e.clientY - rect.top;
                const v = viewRef.current;
                v.dragging = true; v.lastX = e.clientX; v.lastY = e.clientY;
              };
              const onMove = (e) => {
                const v = viewRef.current;
                if (v.dragging) {
                  const dx = e.clientX - v.lastX, dy = e.clientY - v.lastY;
                  v.ry += dx * 0.005;
                  v.rx += dy * 0.005;
                  if (v.rx > 1.5) v.rx = 1.5; else if (v.rx < -1.5) v.rx = -1.5;
                  v.lastX = e.clientX; v.lastY = e.clientY;
                  // 用「从按下点累计位移」判断拖拽，避免轻微抖动被误判为拖拽
                  const rect = c.getBoundingClientRect();
                  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
                  if (Math.abs(mx - down.sx) + Math.abs(my - down.sy) > 6) down.moved = true;
                } else {
                  const rect = c.getBoundingClientRect();
                  const sim = simRef.current;
                  const n = sim ? hitTest(sim, v, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height) : null;
                  hoverRef.current = n ? n.id : null;
                  c.style.cursor = n ? "pointer" : "grab";
                }
              };
              const onUp = (e) => {
                const v = viewRef.current;
                v.dragging = false;
                if (!down.moved) {
                  const rect = c.getBoundingClientRect();
                  const sim = simRef.current;
                  const n = sim ? hitTest(sim, v, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height) : null;
                  setSelected(n);
                }
              };
              const onLeave = () => { viewRef.current.dragging = false; hoverRef.current = null; };
              const onWheel = (e) => {
                e.preventDefault();
                const v = viewRef.current;
                const factor = e.deltaY < 0 ? 1.1 : 0.9;
                v.zoom = Math.max(0.3, Math.min(3, v.zoom * factor));
              };
              c.addEventListener("mousedown", onDown);
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
              c.addEventListener("mouseleave", onLeave);
              c.addEventListener("wheel", onWheel, { passive: false });
              return () => {
                c.removeEventListener("mousedown", onDown);
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                c.removeEventListener("mouseleave", onLeave);
                c.removeEventListener("wheel", onWheel);
              };
            }, []);

            const toggleLevel = (lv) => {
              setHiddenLevels((prev) => {
                const next = new Set(prev);
                if (next.has(lv)) next.delete(lv); else next.add(lv);
                return next;
              });
            };

            const stats = graph ? `节点 ${graph.nodes.length} · 连线 ${graph.links.length} · 拖拽旋转视角` : "";

            return createElement("div", { className: "ms-root" },
              createElement("div", { className: "ms-toolbar" },
                createElement("span", { className: "ms-title" }, "记忆星图"),
                createElement("span", { className: "ms-stats" }, stats),
                LEVEL_ORDER.map((lv) => createElement("button", {
                  key: lv, className: "ms-lv" + (hiddenLevels.has(lv) ? " ms-lv-off" : ""),
                  onClick: () => toggleLevel(lv), title: LEVEL_NAMES[lv],
                },
                  createElement("i", { style: { background: LEVEL_COLORS[lv] } }),
                  LEVEL_NAMES[lv])),
                createElement("input", {
                  className: "ms-search", placeholder: "搜索…", value: search,
                  onChange: (e) => setSearch(e.target.value),
                }),
                createElement("select", {
                  className: "ms-lock", value: lockTarget,
                  onChange: (e) => applyLock(e.target.value), title: "视角锁定",
                },
                  createElement("option", { value: "__center__" }, "锁定：中心"),
                  createElement("option", { value: "__user__" }, "锁定：用户节点"),
                  projectOptions.map((p) => createElement("option", { key: p.id, value: p.id }, "锁定：" + p.name)),
                ),
                createElement("label", { className: "ms-toggle" },
                  createElement("input", { type: "checkbox", checked: showAllLabels, onChange: (e) => setShowAllLabels(e.target.checked) }),
                  "显示全部名字",
                ),
                createElement("button", { className: "ms-refresh", onClick: () => setData((d) => (d ? { ...d } : d)) }, "刷新"),
              ),
              createElement("canvas", { ref: canvasRef, className: "ms-canvas" }),
              loading && createElement("div", { className: "ms-overlay" }, "加载中…"),
              error && createElement("div", { className: "ms-overlay" }, "加载失败：" + error),
              selected && createElement(DetailCard, { node: selected, onClose: () => setSelected(null) }),
            );
          }

          function DetailCard({ node, onClose }) {
            const kw = (node.keywords || []).slice(0, 12).join("、");
            return createElement("div", { className: "ms-detail" },
              createElement("div", { className: "ms-detail-head" },
                createElement("i", { style: { background: LEVEL_COLORS[node.level] } }),
                createElement("b", null, LEVEL_NAMES[node.level] || node.level),
                createElement("button", { onClick: onClose, className: "ms-close" }, "×")),
              createElement("div", { className: "ms-detail-content" }, node.content),
              createElement("div", { className: "ms-detail-meta" },
                createElement("span", null, "重要性 " + (node.importance || 0)),
                createElement("span", null, "状态 " + (node.status || "active")),
                node.project && createElement("span", null, "项目 " + node.project),
                node.subcategory && createElement("span", null, node.subcategory)),
              kw && createElement("div", { className: "ms-detail-kw" }, "关键词：" + kw),
              createElement("div", { className: "ms-detail-time" },
                "更新 " + timefmt(node.updatedAt) + " · 创建 " + timefmt(node.createdAt)),
            );
          }

          const CSS = `
.ms-root{position:relative;width:100%;height:100%;background:#05070f;display:flex;flex-direction:column;overflow:hidden;color:#e2e8f0;font-family:-apple-system,"Segoe UI",sans-serif}
.ms-toolbar{display:flex;align-items:center;gap:7px;padding:7px 12px;flex-wrap:wrap;border-bottom:1px solid rgba(148,163,184,.15);flex:none;z-index:2}
.ms-title{font-weight:650;font-size:13px}
.ms-stats{color:#94a3b8;font-size:11px}
.ms-lv{display:inline-flex;align-items:center;gap:4px;background:rgba(30,41,59,.6);border:1px solid rgba(148,163,184,.2);color:#cbd5e1;border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer}
.ms-lv i{width:8px;height:8px;border-radius:50%}
.ms-lv-off{opacity:.35}
.ms-search{background:rgba(30,41,59,.7);border:1px solid rgba(148,163,184,.2);color:#e2e8f0;border-radius:6px;padding:3px 9px;font-size:11px;min-width:140px}
.ms-toggle{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#cbd5e1;cursor:pointer;user-select:none}
.ms-toggle input{accent-color:#3b82f6;cursor:pointer}
.ms-refresh{background:rgba(30,41,59,.7);border:1px solid rgba(148,163,184,.2);color:#cbd5e1;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer}
.ms-lock{background:rgba(30,41,59,.7);border:1px solid rgba(148,163,184,.2);color:#cbd5e1;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;max-width:170px}
.ms-canvas{flex:1;width:100%;min-height:0;cursor:grab;display:block}
.ms-overlay{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#94a3b8;font-size:13px;background:rgba(7,11,24,.8);padding:10px 16px;border-radius:8px;z-index:3}
.ms-detail{position:absolute;top:52px;right:12px;width:300px;max-width:calc(100% - 24px);max-height:calc(100% - 64px);overflow:auto;background:#111827;border:1px solid rgba(148,163,184,.22);border-radius:10px;padding:12px;box-shadow:0 8px 28px rgba(0,0,0,.4);z-index:3}
.ms-detail-head{display:flex;align-items:center;gap:7px;font-size:12px}
.ms-detail-head i{width:9px;height:9px;border-radius:50%}
.ms-close{margin-left:auto;background:none;border:none;color:#94a3b8;font-size:16px;cursor:pointer}
.ms-detail-content{margin-top:8px;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.ms-detail-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.ms-detail-meta span{background:rgba(30,41,59,.7);border-radius:5px;padding:2px 7px;font-size:10.5px;color:#cbd5e1}
.ms-detail-kw{margin-top:8px;font-size:10.5px;color:#94a3b8;line-height:1.5}
.ms-detail-time{margin-top:8px;font-size:10px;color:#64748b}
`;

          async function apply(ctx) {
            let t = () => "记忆星图";
            try {
              ctx.locale.register("memoryStarmap", {
                en: { "tab.memoryStar": "Memory Star" },
                zh: { "tab.memoryStar": "记忆星图" },
              });
              const bound = ctx.locale.bind("memoryStarmap");
              t = (k) => { try { return bound(k); } catch { return "记忆星图"; } };
            } catch { /* locale 可选 */ }

            const remote = ctx.get("remote");
            let api;
            try {
              await remote.$mount(REMOTE);
              api = ctx.get("remote.memoryGraph");
            } catch (e) {
              api = { getGraph: async () => ({ ok: false, error: { message: (e && e.message) || String(e) } }) };
            }

            ctx.effect(() => {
              const style = document.createElement("style");
              style.dataset.memoryStarmap = "true";
              style.textContent = CSS;
              document.head.append(style);
              return () => style.remove();
            }, "memory-starmap: styles");

            // 左侧导航栏项（替代原会话视图 tab）
            ctx.slots.inject("sidebar.panellist", function* () {
              yield ctx.slots.register({
                name: "sidebar.panellist",
                id: "memory-starmap",
                order: 30,
                locale: "memoryStarmap",
                label: () => t("tab.memoryStar"),
              }, (props) => createElement("span", { className: "ms-nav-item" }, "★"));
            });

            // 主内容区：点击左侧导航项后显示星图
            ctx.slots.inject("main", function* () {
              yield ctx.slots.register({
                name: "main",
                key: "memory-starmap",
                locale: "memoryStarmap",
              }, (props) => createElement(MemoryGraphPanel, { ...props, api }));
            });
          }

          exports.name = name;
          exports.inject = inject;
          exports.apply = apply;
        }
      }
    };

    const cache = Object.create(null);
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const entry = modules[id];
      if (!entry) throw new Error("Unknown memory-starmap module: " + id);
      const module = { exports: {} };
      cache[id] = module;
      entry.run(module, module.exports, (request) => Object.hasOwn(entry.imports, request) ? load(entry.imports[request]) : require(request));
      return module.exports;
    }
    return load("client/index.js");
  }
});
