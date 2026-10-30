/**
 * 通道中心线网络
 *
 * 迷宫生成树的每条树边对应一条"格心 → 相邻格心"的轴对齐线段，
 * 全部线段构成通道中心线网络。能量块的圆心被约束在这个网络上：
 * 圆心位置用 {segIdx, t} 表达（第几条线段 + 段内参数 0~1），
 * 因此"圆心只能沿通道中心线移动"是数据结构层面的保证，而非运行时校验。
 *
 * 由于迷宫是树，网络上任意两点间通路唯一。寻路退化为树上 BFS（O(N)），
 * 这也保证了拖拽时圆心绝不会因为鼠标越过薄墙就瞬移到隔壁通道。
 */
class CorridorNetwork {
    /**
     * @param {Maze} maze
     */
    constructor(maze) {
        this.maze = maze;

        /** 线段：{a, b, ax, ay, bx, by, len}，a/b 为格心下标 */
        this.segments = [];
        /** 节点邻接表：node -> [{node, seg}] */
        this.adjacency = [];
        for (let i = 0; i < maze.cellCount; i++) this.adjacency.push([]);

        for (const edge of maze.edges) {
            const ax = maze.nodeX(edge.a);
            const ay = maze.nodeY(edge.a);
            const bx = maze.nodeX(edge.b);
            const by = maze.nodeY(edge.b);
            const idx = this.segments.length;
            this.segments.push({
                a: edge.a,
                b: edge.b,
                ax, ay, bx, by,
                len: Math.hypot(bx - ax, by - ay),
            });
            this.adjacency[edge.a].push({ node: edge.b, seg: idx });
            this.adjacency[edge.b].push({ node: edge.a, seg: idx });
        }

        this.totalLength = this.segments.reduce((s, seg) => s + seg.len, 0);
    }

    /* ---------------- 基础查询 ---------------- */

    /** 由参数位置解析出像素圆心 */
    pointAt(segIdx, t) {
        const s = this.segments[segIdx] || this.segments[0];
        const tc = CorridorNetwork.clamp01(t);
        return {
            x: s.ax + (s.bx - s.ax) * tc,
            y: s.ay + (s.by - s.ay) * tc,
        };
    }

    static clamp01(v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    /**
     * 把任意像素点投影到网络上最近的位置
     * @returns {{segIdx:number, t:number, x:number, y:number, dist:number}}
     */
    projectPoint(px, py) {
        let best = null;
        for (let i = 0; i < this.segments.length; i++) {
            const s = this.segments[i];
            const vx = s.bx - s.ax;
            const vy = s.by - s.ay;
            const len2 = vx * vx + vy * vy;
            let t = len2 === 0 ? 0 : ((px - s.ax) * vx + (py - s.ay) * vy) / len2;
            t = CorridorNetwork.clamp01(t);
            const x = s.ax + vx * t;
            const y = s.ay + vy * t;
            const dist = Math.hypot(px - x, py - y);
            if (!best || dist < best.dist) best = { segIdx: i, t, x, y, dist };
        }
        return best || { segIdx: 0, t: 0, x: 0, y: 0, dist: Infinity };
    }

    /** 取网络上离给定像素点最近的参数位置 */
    locate(px, py) {
        const p = this.projectPoint(px, py);
        return { segIdx: p.segIdx, t: p.t };
    }

    /** 随机取一个网络上的位置 */
    randomPosition(rng) {
        const segIdx = Math.floor(rng() * this.segments.length);
        return { segIdx, t: rng() };
    }

    /* ---------------- 树上寻路 ---------------- */

    /** 两格心之间的唯一节点路径（含首尾） */
    treePathNodes(from, to) {
        if (from === to) return [from];
        const total = this.maze.cellCount;
        const prev = new Array(total).fill(-1);
        const seen = new Array(total).fill(false);
        const queue = [from];
        let head = 0;
        seen[from] = true;

        while (head < queue.length) {
            const cur = queue[head++];
            if (cur === to) break;
            for (const nb of this.adjacency[cur]) {
                if (!seen[nb.node]) {
                    seen[nb.node] = true;
                    prev[nb.node] = cur;
                    queue.push(nb.node);
                }
            }
        }

        if (!seen[to]) return [from];
        const path = [];
        let cur = to;
        while (cur !== -1) {
            path.push(cur);
            cur = prev[cur];
        }
        return path.reverse();
    }

    /** 节点路径的像素长度 */
    nodePathLength(nodes) {
        let len = 0;
        for (let i = 0; i + 1 < nodes.length; i++) {
            len += Math.hypot(
                this.maze.nodeX(nodes[i + 1]) - this.maze.nodeX(nodes[i]),
                this.maze.nodeY(nodes[i + 1]) - this.maze.nodeY(nodes[i])
            );
        }
        return len;
    }

    /**
     * 构建两个参数位置之间的行进折线
     * @param {{segIdx:number,t:number}} fromPos
     * @param {{segIdx:number,t:number}} toPos
     * @returns {{waypoints:Array<{x:number,y:number}>, length:number, cum:Array<number>}}
     */
    buildPath(fromPos, toPos) {
        const s1 = this.segments[fromPos.segIdx];
        const s2 = this.segments[toPos.segIdx];
        const start = this.pointAt(fromPos.segIdx, fromPos.t);
        const end = this.pointAt(toPos.segIdx, toPos.t);

        let bestNodes = null;
        let bestLength = Infinity;
        let bestFromNode = s1.a;
        let bestToNode = s2.a;

        // 同一条线段：直接沿段走最短，不必绕经端点
        if (fromPos.segIdx === toPos.segIdx) {
            const direct = Math.abs(toPos.t - fromPos.t) * s1.len;
            bestNodes = [];
            bestLength = direct;
            bestFromNode = -1;
            bestToNode = -1;
        }

        const fromCands = [
            { node: s1.a, d: Math.hypot(start.x - this.maze.nodeX(s1.a), start.y - this.maze.nodeY(s1.a)) },
            { node: s1.b, d: Math.hypot(start.x - this.maze.nodeX(s1.b), start.y - this.maze.nodeY(s1.b)) },
        ];
        const toCands = [
            { node: s2.a, d: Math.hypot(end.x - this.maze.nodeX(s2.a), end.y - this.maze.nodeY(s2.a)) },
            { node: s2.b, d: Math.hypot(end.x - this.maze.nodeX(s2.b), end.y - this.maze.nodeY(s2.b)) },
        ];

        for (const f of fromCands) {
            for (const g of toCands) {
                const nodes = this.treePathNodes(f.node, g.node);
                const len = f.d + this.nodePathLength(nodes) + g.d;
                if (len < bestLength) {
                    bestLength = len;
                    bestNodes = nodes;
                    bestFromNode = f.node;
                    bestToNode = g.node;
                }
            }
        }

        const waypoints = [start];
        if (bestFromNode === -1) {
            waypoints.push(end);
        } else {
            for (const n of bestNodes) {
                waypoints.push({ x: this.maze.nodeX(n), y: this.maze.nodeY(n) });
            }
            waypoints.push(end);
        }

        // 去掉重复点，避免零长线段
        const cleaned = [waypoints[0]];
        for (let i = 1; i < waypoints.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            if (Math.hypot(waypoints[i].x - prev.x, waypoints[i].y - prev.y) > 0.01) {
                cleaned.push(waypoints[i]);
            }
        }

        const cum = [0];
        let acc = 0;
        for (let i = 0; i + 1 < cleaned.length; i++) {
            acc += Math.hypot(cleaned[i + 1].x - cleaned[i].x, cleaned[i + 1].y - cleaned[i].y);
            cum.push(acc);
        }

        return { waypoints: cleaned, cum, length: acc };
    }

    /** 取折线上距起点 d 像素处的点 */
    pointAtDistance(path, d) {
        const pts = path.waypoints;
        if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
        const target = Math.max(0, Math.min(d, path.length));
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            if (target <= path.cum[i] + segLen || i === pts.length - 2) {
                const local = segLen === 0 ? 0 : CorridorNetwork.clamp01((target - path.cum[i]) / segLen);
                return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
            }
        }
        const last = pts[pts.length - 1];
        return { x: last.x, y: last.y };
    }

    /**
     * 沿折线推进
     * @param {object} path - buildPath 的结果
     * @param {number} traveled - 已行进距离（像素）
     * @param {number} stepPx - 本帧可前进的像素数
     * @returns {{pos:{segIdx:number,t:number}, point:{x:number,y:number}, movedPx:number, traveled:number, finished:boolean}}
     */
    advance(path, traveled, stepPx) {
        const remain = Math.max(0, path.length - traveled);
        const moved = Math.min(stepPx, remain);
        const nextTraveled = traveled + moved;
        const point = this.pointAtDistance(path, nextTraveled);
        const pos = this.locate(point.x, point.y);
        return {
            pos,
            point,
            movedPx: moved,
            traveled: nextTraveled,
            finished: remain - moved < 0.001,
        };
    }

    /**
     * 两个参数位置之间沿通道的实际距离（用于"是否隔墙相触"的判定）
     */
    pathDistance(fromPos, toPos) {
        if (fromPos.segIdx === toPos.segIdx) {
            const s = this.segments[fromPos.segIdx];
            return Math.abs(toPos.t - fromPos.t) * s.len;
        }
        const s1 = this.segments[fromPos.segIdx];
        const s2 = this.segments[toPos.segIdx];
        let best = Infinity;
        for (const fa of [s1.a, s1.b]) {
            for (const ga of [s2.a, s2.b]) {
                const faT = fa === s1.a ? fromPos.t : 1 - fromPos.t;
                const gaT = ga === s2.a ? toPos.t : 1 - toPos.t;
                const d =
                    faT * s1.len +
                    this.nodePathLength(this.treePathNodes(fa, ga)) +
                    gaT * s2.len;
                if (d < best) best = d;
            }
        }
        return best;
    }
}
