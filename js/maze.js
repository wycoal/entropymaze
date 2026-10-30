/**
 * 迷宫类 —— 随机完美迷宫（生成树）
 *
 * 与旧版的区别：
 *  - 旧版用 0/1 二维数组表示"整格墙"，墙占据整个格子；
 *  - 新版把迷宫抽象为「格心节点 + 树边通道」，墙退化为画在网格线上的细长矩形，
 *    只保留很薄的可见厚度，通道因此变得宽敞。
 *
 * 生成算法为随机化 DFS（迭代式），生成的是一棵生成树，因此数学上保证：
 *  1. 任意两个格心之间连通；
 *  2. 不存在任何闭合环路（用户明确要求：通道不得形成闭环空间）；
 *  3. 任意两点之间的通路唯一 —— 这条性质是"圆心禁止穿墙瞬移"的数学保证。
 */
class Maze {
    /**
     * @param {number} cols - 列数（格心数）
     * @param {number} rows - 行数（格心数）
     * @param {number} pitch - 相邻格心的间距（像素），同时也是通道的"格距"
     * @param {number} wallThickness - 薄墙厚度（像素）
     * @param {Function} rng - 随机源 () => [0,1)
     */
    constructor(cols, rows, pitch, wallThickness, rng) {
        this.cols = cols;
        this.rows = rows;
        this.pitch = pitch;
        this.wallThickness = wallThickness;
        this.rng = typeof rng === 'function' ? rng : Math.random;

        // 让最外侧的墙也能完整落在画布内：整体向外偏移半个墙厚
        this.originX = wallThickness / 2;
        this.originY = wallThickness / 2;
        this.width = cols * pitch + wallThickness;
        this.height = rows * pitch + wallThickness;

        this.cellCount = cols * rows;

        /** 树边：{a, b} 为格心下标 */
        this.edges = [];
        /** 通道查找表：key = `${min}_${max}` */
        this.passages = new Set();

        /** 薄墙矩形清单 {x, y, w, h} */
        this.walls = [];

        this.generate();
        this.buildWalls();
    }

    /* ---------------- 索引与坐标 ---------------- */

    /** 格心下标 */
    index(c, r) {
        return r * this.cols + c;
    }

    colOf(i) {
        return i % this.cols;
    }

    rowOf(i) {
        return Math.floor(i / this.cols);
    }

    /** 第 c 列格心的 X 像素坐标 */
    centerX(c) {
        return this.originX + this.pitch / 2 + c * this.pitch;
    }

    /** 第 r 行格心的 Y 像素坐标 */
    centerY(r) {
        return this.originY + this.pitch / 2 + r * this.pitch;
    }

    nodeX(i) {
        return this.centerX(this.colOf(i));
    }

    nodeY(i) {
        return this.centerY(this.rowOf(i));
    }

    /** 网格竖线（第 c 列左侧）的 X 像素坐标，c 取 0..cols */
    gridLineX(c) {
        return this.originX + c * this.pitch;
    }

    /** 网格横线（第 r 行上方）的 Y 像素坐标，r 取 0..rows */
    gridLineY(r) {
        return this.originY + r * this.pitch;
    }

    /* ---------------- 生成树 ---------------- */

    /** 取某个格心的四邻居（在界内） */
    neighborsOf(i) {
        const c = this.colOf(i);
        const r = this.rowOf(i);
        const list = [];
        if (r > 0) list.push(this.index(c, r - 1));
        if (r < this.rows - 1) list.push(this.index(c, r + 1));
        if (c > 0) list.push(this.index(c - 1, r));
        if (c < this.cols - 1) list.push(this.index(c + 1, r));
        return list;
    }

    addEdge(a, b) {
        this.edges.push({ a, b });
        this.passages.add(Maze.passageKey(a, b));
    }

    static passageKey(a, b) {
        return a < b ? `${a}_${b}` : `${b}_${a}`;
    }

    hasPassage(a, b) {
        return this.passages.has(Maze.passageKey(a, b));
    }

    /** 随机化 DFS（迭代式）生成生成树 */
    generate() {
        this.edges = [];
        this.passages = new Set();

        const visited = new Array(this.cellCount).fill(false);
        const start = Math.floor(this.rng() * this.cellCount);
        const stack = [start];
        visited[start] = true;
        let visitedCount = 1;

        while (stack.length > 0) {
            const current = stack[stack.length - 1];
            const candidates = this.neighborsOf(current).filter((n) => !visited[n]);

            if (candidates.length === 0) {
                stack.pop();
                continue;
            }

            const next = candidates[Math.floor(this.rng() * candidates.length)];
            this.addEdge(current, next);
            visited[next] = true;
            visitedCount++;
            stack.push(next);
        }

        // 兜底：理论上不会发生，保证不出现孤立格心
        if (visitedCount !== this.cellCount) {
            for (let i = 0; i < this.cellCount; i++) {
                if (!visited[i]) continue;
                for (const n of this.neighborsOf(i)) {
                    if (!visited[n]) {
                        this.addEdge(i, n);
                        visited[n] = true;
                        visitedCount++;
                    }
                }
            }
        }
    }

    /* ---------------- 薄墙 ---------------- */

    /**
     * 墙画在网格线上：有通道的地方不画墙，其余位置画一条细长矩形。
     * 长度在格距基础上两端各外扩半个墙厚，使拐角自然封口，无需额外补块。
     */
    buildWalls() {
        this.walls = [];
        const t = this.wallThickness;
        const half = t / 2;
        const span = this.pitch + t; // 外扩后的长度

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const self = this.index(c, r);

                // 右侧：要么与右邻无通道，要么就是最右边界
                const rightIdx = c < this.cols - 1 ? this.index(c + 1, r) : -1;
                if (rightIdx === -1 || !this.hasPassage(self, rightIdx)) {
                    this.walls.push({
                        x: this.gridLineX(c + 1) - half,
                        y: this.gridLineY(r) - half,
                        w: t,
                        h: span,
                    });
                }

                // 下方：要么与下邻无通道，要么就是最下边界
                const downIdx = r < this.rows - 1 ? this.index(c, r + 1) : -1;
                if (downIdx === -1 || !this.hasPassage(self, downIdx)) {
                    this.walls.push({
                        x: this.gridLineX(c) - half,
                        y: this.gridLineY(r + 1) - half,
                        w: span,
                        h: t,
                    });
                }

                // 左边界
                if (c === 0) {
                    this.walls.push({
                        x: this.gridLineX(0) - half,
                        y: this.gridLineY(r) - half,
                        w: t,
                        h: span,
                    });
                }

                // 上边界
                if (r === 0) {
                    this.walls.push({
                        x: this.gridLineX(c) - half,
                        y: this.gridLineY(0) - half,
                        w: span,
                        h: t,
                    });
                }
            }
        }
    }

    /** 通道净宽（像素）：相邻两面墙之间的可用空间 */
    get corridorWidth() {
        return this.pitch - this.wallThickness;
    }

    /** 迷宫自检：是否为无环连通图（边数 = 节点数 - 1 且连通） */
    validate() {
        const seen = new Array(this.cellCount).fill(false);
        const stack = [0];
        seen[0] = true;
        let count = 1;
        while (stack.length) {
            const cur = stack.pop();
            for (const n of this.neighborsOf(cur)) {
                if (this.hasPassage(cur, n) && !seen[n]) {
                    seen[n] = true;
                    count++;
                    stack.push(n);
                }
            }
        }
        return {
            isConnected: count === this.cellCount,
            isAcyclic: this.edges.length === this.cellCount - 1,
            nodeCount: this.cellCount,
            edgeCount: this.edges.length,
        };
    }
}
