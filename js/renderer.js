/**
 * 渲染引擎 —— 暗色科技风 / 线框迷宫 / 发光能量球
 *
 * 绘制顺序（自下而上）：
 *   1. 静态层：底色 + 薄墙（离屏缓存，仅迷宫重建时重绘）
 *   2. 网格辅助线（可选）
 *   3. 通道中心线虚线（可选）
 *   4. 拖拽行进路径与目标幽灵圆
 *   5. 能量球（球体渐变 + 温度光晕 + 自适应对比描边）
 *   6. 可合并高亮与合并动画
 *
 * 能量球画在墙之后且不做任何裁剪，因此半径膨胀到超过通道宽度时会自然压在墙上。
 */
class Renderer {
    constructor(canvas, maze, corridor) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.maze = maze;
        this.corridor = corridor;

        this.showCenterline = true;
        this.showGrid = false;
        this.showTemperature = false;
        this.showExergy = false;

        /** 合并动画队列，进度由 Game 的主循环推进 */
        this.animations = [];
        /** 摩擦耗散热的扩散光环 */
        this.dissipations = [];

        /** 光团粒子：做功飞入罐体 / 摩擦从罐体飞出 */
        this.orbs = [];
        /** 合并特效：显示可用能减少的浮动文字与光团 */
        this.mergeEffects = [];
        /** 储能罐 DOM 元素引用（由 Game 注入），用于计算光团飞行目标 */
        this._accumulatorEl = null;
        /** 储能罐的液位 / 读数 DOM */
        this._tankEl = null;
        this._tankLiquidEl = null;
        this._tankValueEl = null;
        this._tankFlowTimer = null;
        /** 罐体旁的流入 / 流出浮动读数 */
        this.tankFlashes = [];

        /** 储能罐液位动画值 (0~1) */
        this._tankFill = 0;
        this._tankMax = 1000;
        /** 温度色标区间：T0 为最冷端，T_max 为最热端 */
        this._maxTemp = 300;
        this._minTemp = 20;

        this.staticLayer = document.createElement('canvas');
        this.staticDirty = true;
    }

    /* ---------------- 显示选项 ---------------- */

    updateDisplayOptions(options = {}) {
        if (options.showCenterline !== undefined) this.showCenterline = options.showCenterline;
        if (options.showGrid !== undefined) this.showGrid = options.showGrid;
        if (options.showTemperature !== undefined) this.showTemperature = options.showTemperature;
        if (options.showExergy !== undefined) this.showExergy = options.showExergy;
    }

    invalidateStatic() {
        this.staticDirty = true;
    }

    /* ---------------- 静态层：底色 + 薄墙 ---------------- */

    ensureStatic() {
        if (!this.staticDirty) return;
        const w = this.maze.width;
        const h = this.maze.height;
        this.staticLayer.width = w;
        this.staticLayer.height = h;
        const ctx = this.staticLayer.getContext('2d');

        ctx.clearRect(0, 0, w, h);

        // 底色：中心略亮的深空渐变
        const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.72);
        bg.addColorStop(0, '#141A24');
        bg.addColorStop(1, '#0B0E14');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        // 薄墙：一次成路径后统一填充，避免上千次 fill 调用
        ctx.beginPath();
        for (const wall of this.maze.walls) {
            ctx.rect(wall.x, wall.y, wall.w, wall.h);
        }
        ctx.fillStyle = '#1B2230';
        ctx.fill();
        ctx.strokeStyle = 'rgba(77, 208, 225, 0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();

        this.staticDirty = false;
    }

    /* ---------------- 辅助层 ---------------- */

    drawGrid() {
        const ctx = this.ctx;
        const m = this.maze;
        ctx.save();
        ctx.strokeStyle = 'rgba(154, 167, 184, 0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = 0; c <= m.cols; c++) {
            ctx.moveTo(m.gridLineX(c), m.gridLineY(0));
            ctx.lineTo(m.gridLineX(c), m.gridLineY(m.rows));
        }
        for (let r = 0; r <= m.rows; r++) {
            ctx.moveTo(m.gridLineX(0), m.gridLineY(r));
            ctx.lineTo(m.gridLineX(m.cols), m.gridLineY(r));
        }
        ctx.stroke();
        ctx.restore();
    }

    drawCenterlines() {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(77, 208, 225, 0.18)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 6]);
        ctx.beginPath();
        for (const seg of this.corridor.segments) {
            ctx.moveTo(seg.ax, seg.ay);
            ctx.lineTo(seg.bx, seg.by);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    /* ---------------- 温度色彩映射（Turbo 色标） ---------------- */

    /**
     * Turbo 色标：多色单调映射（紫→蓝→青→绿→黄→橙→红），
     * 采用 Google Turbo 的多项式近似（误差 < 1%），专用于"数值 → 颜色"的连续映射。
     * @param {number} ratio 0~1（温度归一化值：0 = T0，1 = T_max）
     * @returns {[number,number,number]} RGB
     */
    temperatureColor(ratio) {
        const v = Math.max(0, Math.min(1, ratio));
        const v2 = v * v, v3 = v2 * v, v4 = v3 * v, v5 = v4 * v;
        const r = 0.13572138 + 4.61539260 * v - 42.66032258 * v2 + 132.13108234 * v3 - 152.94239396 * v4 + 59.28637943 * v5;
        const g = 0.09140261 + 2.19418839 * v + 4.84296658 * v2 - 14.18503333 * v3 + 4.27729857 * v4 + 2.82956604 * v5;
        const b = 0.10667330 + 12.64194608 * v - 60.58204836 * v2 + 110.36276771 * v3 - 89.90310912 * v4 + 27.34824973 * v5;
        return [
            Math.round(Math.max(0, Math.min(1, r)) * 255),
            Math.round(Math.max(0, Math.min(1, g)) * 255),
            Math.round(Math.max(0, Math.min(1, b)) * 255),
        ];
    }

    /** 摄氏温度 → CSS 颜色（球体、光晕、合并残影共用同一套色标） */
    tempColorCss(celsius) {
        const span = Math.max(1e-6, this._maxTemp - this._minTemp);
        const [r, g, b] = this.temperatureColor((celsius - this._minTemp) / span);
        return `rgb(${r}, ${g}, ${b})`;
    }

    /* ---------------- 能量球 ---------------- */

    /**
     * @param {EnergyBlock} block
     * @param {object} opts - {x, y, selected, highlighted, time, scale}
     *   x / y 可覆盖圆心：拾取跟随阶段球画在自由位置，而非通道上的真实位置
     */
    drawOrb(block, opts = {}) {
        const ctx = this.ctx;
        const r = block.radius * (opts.scale !== undefined ? opts.scale : 1);
        if (r <= 0.5) return;

        const cx = opts.x !== undefined ? opts.x : block.x;
        const cy = opts.y !== undefined ? opts.y : block.y;

        // 颜色只对应温度（不随能量变化）：T0 → T_max 铺满 Turbo 全色带
        const span = Math.max(1e-6, this._maxTemp - this._minTemp);
        const heatRatio = Math.max(0, Math.min(1, ((block.temperature || 0) - this._minTemp) / span));
        const [cr, cg, cb] = this.temperatureColor(heatRatio);

        // 极缓慢移动的高光，暗示球体而非平面色块
        const spin = (opts.time || 0) * 0.0006;
        const hx = cx + Math.cos(spin) * r * 0.34;
        const hy = cy + Math.sin(spin) * r * 0.34 - r * 0.12;

        // 亮 / 中 / 暗三色梯度
        const hiR = Math.min(255, cr + 80);
        const hiG = Math.min(255, cg + 80);
        const hiB = Math.min(255, cb + 80);
        const loR = Math.max(0, cr - 55);
        const loG = Math.max(0, cg - 55);
        const loB = Math.max(0, cb - 55);

        ctx.save();
        // 温度越高，光晕越强（色相仍由温度决定）
        ctx.shadowColor = `rgba(${cr}, ${cg}, ${cb}, ${(0.22 + 0.6 * heatRatio).toFixed(3)})`;
        ctx.shadowBlur = 8 + 22 * heatRatio;

        const grad = ctx.createRadialGradient(hx, hy, r * 0.08, cx, cy, r);
        grad.addColorStop(0, `rgb(${hiR}, ${hiG}, ${hiB})`);
        grad.addColorStop(0.55, `rgb(${cr}, ${cg}, ${cb})`);
        grad.addColorStop(1, `rgb(${loR}, ${loG}, ${loB})`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 外层辉光环
        ctx.save();
        ctx.globalAlpha = 0.15 + 0.35 * heatRatio;
        ctx.strokeStyle = `rgb(${cr}, ${cg}, ${cb})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // 描边
        let strokeColor = 'rgba(230, 237, 243, 0.5)';
        if (opts.highlighted) {
            strokeColor = `rgba(255, 193, 77, ${0.55 + 0.45 * Math.sin((opts.time || 0) * 0.008)})`;
        } else if (opts.selected) {
            strokeColor = '#FFC14D';
        }
        ctx.save();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = opts.selected || opts.highlighted ? 3 : 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // 文本标签：温度 / 内能 / 可用能 三行
        if (r >= 9) {
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 3;
            // 深色描边，保证在任何色带的球体上都可读
            ctx.strokeStyle = 'rgba(6, 9, 14, 0.88)';

            const lines = [
                [`${block.temperature.toFixed(0)}°C`, '#FFFFFF', '600 12px'],
                [`U ${(block.internalEnergy || 0).toFixed(0)} J`, '#8CF3FF', '500 10px'],
                [`E ${(block.exergy || 0).toFixed(0)} J`, '#FFD166', '500 10px'],
            ];
            const gap = 11;
            let ty = cy - gap;
            for (const [text, color, font] of lines) {
                ctx.font = `${font} "Noto Sans", Arial, sans-serif`;
                ctx.fillStyle = color;
                ctx.strokeText(text, cx, ty);
                ctx.fillText(text, cx, ty);
                ty += gap;
            }
            ctx.restore();
        }
    }

    /* ---------------- 拾取预览 ---------------- */

    /**
     * 拾取阶段：出发位置虚线圈 → 通道行进折线 → 落点幽灵圆与准星
     * @param {object} carry - {block, free:{x,y}, target:{x,y}, path, valid}
     */
    drawCarryPreview(carry) {
        const ctx = this.ctx;
        const color = carry.valid ? '#4DD0E1' : '#FF5A5F';
        const block = carry.block;

        ctx.save();

        // 行进路径：从当前圆心（通道上）到落点的唯一通道折线
        if (carry.path && carry.path.waypoints.length > 1) {
            ctx.strokeStyle = carry.valid ? 'rgba(77, 208, 225, 0.65)' : 'rgba(255, 90, 95, 0.55)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 5]);
            ctx.beginPath();
            const pts = carry.path.waypoints;
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 出发位置：空心虚线圈，标明"从这里出发"
        ctx.strokeStyle = 'rgba(154, 167, 184, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(block.x, block.y, block.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // 落点幽灵圆
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(carry.target.x, carry.target.y, block.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(carry.target.x, carry.target.y, block.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // 落点十字准星
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(carry.target.x - 7, carry.target.y);
        ctx.lineTo(carry.target.x + 7, carry.target.y);
        ctx.moveTo(carry.target.x, carry.target.y - 7);
        ctx.lineTo(carry.target.x, carry.target.y + 7);
        ctx.stroke();

        ctx.restore();
    }

    /**
     * "确认后的变化" 浮层：紧跟被拾取的球，逐项列出增量
     * @param {object} preview - updatePreview() 的结果
     * @param {object} carry - {block, free:{x,y}}
     */
    drawPreviewPanel(preview, carry) {
        if (!preview) return;
        const rows = [
            ['移动距离', `+${preview.meters.toFixed(2)} m`, '#4DD0E1'],
            ['摩擦耗散', `+${preview.friction.work.toFixed(1)} J`, '#4DD0E1'],
            ['累计熵产', `+${preview.entropyGenerated.toFixed(3)} J/K`, '#9A67EA'],
            ['累计㶲损', `+${preview.exergyDestroyed.toFixed(1)} J`, '#FF8A65'],
            ['可用能', `-${preview.exergyDestroyed.toFixed(1)} J`, '#FF5A5F'],
        ];
        // 蓄能器：付不起本次摩擦时提前标红警示（需求为 0 时余额为负也放行）
        if (preview.accumulatorAfter !== undefined) {
            rows.push(preview.accumulatorBlocked
                ? ['蓄能器不足', `${preview.accumulatorAfter.toFixed(0)} J`, '#FF5A5F']
                : ['蓄能器余量', `${preview.accumulatorAfter.toFixed(0)} J`, '#FFC14D']);
        }
        if (preview.merged) {
            rows.push([
                '将合并',
                `${preview.merged.temperature.toFixed(0)}°C · m=${preview.merged.mass.toFixed(1)}`,
                '#FFC14D',
            ]);
        }

        const ctx = this.ctx;
        const w = 176;
        const lineH = 17;
        const h = 26 + rows.length * lineH + 24;

        // 优先放在球的右下方，越界则翻到另一侧并夹在画布内
        let x = carry.free.x + carry.block.radius + 12;
        let y = carry.free.y + carry.block.radius + 12;
        if (x + w > this.canvas.width) x = carry.free.x - carry.block.radius - 12 - w;
        if (y + h > this.canvas.height) y = carry.free.y - carry.block.radius - 12 - h;
        x = Math.max(4, Math.min(x, this.canvas.width - w - 4));
        y = Math.max(4, Math.min(y, this.canvas.height - h - 4));

        ctx.save();
        ctx.fillStyle = 'rgba(11, 14, 20, 0.88)';
        ctx.strokeStyle = 'rgba(77, 208, 225, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
        else ctx.rect(x, y, w, h);
        ctx.fill();
        ctx.stroke();

        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = '600 11px "Noto Sans", Arial, sans-serif';
        ctx.fillStyle = 'rgba(230, 237, 243, 0.75)';
        ctx.fillText('确认后的变化', x + 10, y + 14);

        let ty = y + 26 + lineH / 2;
        for (const [label, value, color] of rows) {
            ctx.textAlign = 'left';
            ctx.font = '400 11px "Noto Sans", Arial, sans-serif';
            ctx.fillStyle = 'rgba(154, 167, 184, 0.95)';
            ctx.fillText(label, x + 10, ty);
            ctx.textAlign = 'right';
            ctx.font = '600 11px "Noto Sans", Arial, sans-serif';
            ctx.fillStyle = color;
            ctx.fillText(value, x + w - 10, ty);
            ty += lineH;
        }

        ctx.textAlign = 'left';
        ctx.font = '400 10px "Noto Sans", Arial, sans-serif';
        ctx.fillStyle = 'rgba(154, 167, 184, 0.6)';
        ctx.fillText('再次点击确认 · Esc 取消', x + 10, y + h - 11);
        ctx.restore();
    }

    /**
     * 可合并：两球之间连一条琥珀虚线
     * @param {object} from - 起点覆盖（被拾取的球用自由位置）
     */
    drawMergeLink(a, b, time, from) {
        const ctx = this.ctx;
        const p = from || a;
        const alpha = 0.55 + 0.45 * Math.sin(time * 0.008);
        ctx.save();
        ctx.strokeStyle = `rgba(255, 193, 77, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    /* ---------------- 合并动画 ---------------- */

    /**
     * @param {object} anim - {a:{x,y,r,gray}, b:{x,y,r,gray}, target:EnergyBlock, progress}
     */
    addMergeAnimation(anim) {
        anim.progress = 0;
        this.animations.push(anim);
    }

    drawAnimationFrame(anim) {
        const ctx = this.ctx;
        const p = Math.max(0, Math.min(1, anim.progress));

        // 旧球收缩淡出
        for (const src of [anim.a, anim.b]) {
            if (!src) continue;
            const r = src.r * (1 - 0.75 * p);
            if (r <= 0.5) continue;
            ctx.save();
            ctx.globalAlpha = 1 - p;
            ctx.fillStyle = src.color || `rgb(${src.gray}, ${src.gray}, ${src.gray})`;
            ctx.beginPath();
            ctx.arc(src.x, src.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // 扩散光环
        const cx = anim.target ? anim.target.x : (anim.a ? anim.a.x : 0);
        const cy = anim.target ? anim.target.y : (anim.a ? anim.a.y : 0);
        const ringR = (anim.a ? anim.a.r : 10) + p * 46;
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.55;
        ctx.strokeStyle = '#FFC14D';
        ctx.lineWidth = 2.5 * (1 - p) + 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // 新球放大淡入
        if (anim.target) {
            const scale = 0.25 + 0.75 * p;
            ctx.save();
            ctx.globalAlpha = p;
            this.drawOrb(anim.target, { scale, time: anim.time || 0 });
            ctx.restore();
        }
    }

    /* ---------------- 做功爆炸 ---------------- */

    /**
     * 释放可用能的爆炸：规模由释放的功决定
     * @param {object} anim - {x, y, r, power:本次释放的功(J)}
     */
    addExplosion(anim) {
        anim.type = 'explosion';
        anim.progress = 0;
        anim.duration = 0.75;
        // √power 归一到 0~1：power ≈ 400 J 时达到满规模
        anim.strength = Math.min(1, Math.sqrt(Math.max(anim.power, 0)) / 20);
        this.animations.push(anim);
    }

    drawExplosionFrame(anim) {
        const ctx = this.ctx;
        const p = Math.max(0, Math.min(1, anim.progress));
        const s = anim.strength;
        const baseR = anim.r || 10;
        const maxR = baseR + 22 + 96 * s;
        const cx = anim.x;
        const cy = anim.y;

        ctx.save();

        // 1) 起爆闪光：前 35% 迅速亮起再熄灭
        if (p < 0.35) {
            const f = 1 - p / 0.35;
            ctx.globalAlpha = f * 0.85;
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(cx, cy, baseR * (1 + 1.6 * (1 - f)), 0, Math.PI * 2);
            ctx.fill();
        }

        // 2) 三道错峰冲击波（白 → 琥珀 → 红）
        const waves = [
            { delay: 0.00, color: '#FFFFFF' },
            { delay: 0.12, color: '#FFC14D' },
            { delay: 0.26, color: '#FF5A5F' },
        ];
        for (const w of waves) {
            const q = (p - w.delay) / (1 - w.delay);
            if (q <= 0 || q >= 1) continue;
            const ease = 1 - Math.pow(1 - q, 2.4); // 先快后慢
            ctx.globalAlpha = (1 - q) * 0.8;
            ctx.strokeStyle = w.color;
            ctx.lineWidth = (3.2 + 2.4 * s) * (1 - q) + 0.5;
            ctx.beginPath();
            ctx.arc(cx, cy, baseR + (maxR - baseR) * ease, 0, Math.PI * 2);
            ctx.stroke();
        }

        // 3) 放射火花：条数与长度都随释放大小增加
        const spokes = Math.round(8 + 20 * s);
        const inner = baseR + (maxR - baseR) * (0.35 + 0.5 * s) * Math.min(1, p * 2.2);
        ctx.lineCap = 'round';
        for (let i = 0; i < spokes; i++) {
            const a = (i / spokes) * Math.PI * 2 + s * 0.7;
            const len = (10 + 26 * s) * (1 - p) * (0.6 + 0.4 * Math.abs(Math.sin(i * 2.7)));
            ctx.globalAlpha = (1 - p) * 0.9;
            ctx.strokeStyle = i % 3 === 0 ? '#FFFFFF' : (i % 3 === 1 ? '#FFC14D' : '#FF8A65');
            ctx.lineWidth = 2.2 * (1 - p) + 0.4;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
            ctx.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
            ctx.stroke();
        }

        ctx.restore();
    }

    /* ---------------- 达标烟花 ---------------- */

    /**
     * 单次做功释放超过达标线（300 J）时的烟花庆祝。
     * 数枚礼花从释放点斜向上飞，到各自顶点炸开成带重力与空气阻力的彩色粒子。
     * 位移按时间解析求解（而非逐帧积分），与帧率无关。
     * @param {object} anim - {x, y, power:本次释放的功(J)}
     */
    addFireworks(anim) {
        anim.type = 'fireworks';
        anim.progress = 0;
        anim.duration = 2.2;
        const s = Math.min(1, Math.sqrt(Math.max(anim.power, 0)) / 20);
        const palette = ['#FFC14D', '#FF5A5F', '#4DD0E1', '#66BB6A', '#7E57C2', '#FF80AB', '#FFFFFF'];
        const shellCount = Math.round(4 + 5 * s);
        anim.shells = [];

        for (let i = 0; i < shellCount; i++) {
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;   // 主要朝上
            const speed = 150 + Math.random() * 130;
            const rise = 0.28 + Math.random() * 0.24;                   // 上升时长（秒）
            const vx = Math.cos(angle) * speed * 0.55;
            const vy = Math.sin(angle) * speed;
            const count = Math.round(24 + 22 * s);
            const particles = [];
            for (let j = 0; j < count; j++) {
                particles.push({
                    angle: (j / count) * Math.PI * 2 + Math.random() * 0.25,
                    speed: (80 + Math.random() * 120) * (0.75 + 0.45 * s),
                    phase: Math.random() * Math.PI * 2,
                });
            }
            anim.shells.push({
                delay: i * (0.16 - 0.06 * s) * (0.7 + 0.6 * Math.random()),   // 错峰升空
                rise,
                vx, vy,
                x0: anim.x,
                y0: anim.y,
                ax: anim.x + vx * rise,      // 炸点
                ay: anim.y + vy * rise,
                color: palette[Math.floor(Math.random() * palette.length)],
                particles,
            });
        }
        this.animations.push(anim);
    }

    drawFireworksFrame(anim) {
        const ctx = this.ctx;
        const GRAVITY = 190;    // px/s²
        const DRAG = 2.4;       // 空气阻力系数（1/s）
        const LIFE = 1.15;      // 单颗粒子存活时长（秒）
        const t = Math.max(0, Math.min(1, anim.progress)) * anim.duration;

        ctx.save();
        ctx.lineCap = 'round';
        for (const shell of anim.shells) {
            const tt = t - shell.delay;
            if (tt <= 0) continue;

            if (tt < shell.rise) {
                // 上升阶段：亮点 + 尾迹
                const x = shell.x0 + shell.vx * tt;
                const y = shell.y0 + shell.vy * tt;
                ctx.globalAlpha = 0.9;
                ctx.fillStyle = '#FFF3C4';
                ctx.beginPath();
                ctx.arc(x, y, 1.8, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 0.4;
                ctx.strokeStyle = '#FFC14D';
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.moveTo(x - shell.vx * 0.05, y - shell.vy * 0.05);
                ctx.lineTo(x, y);
                ctx.stroke();
                continue;
            }

            const bt = tt - shell.rise;

            // 起爆闪光
            if (bt < 0.12) {
                ctx.globalAlpha = (1 - bt / 0.12) * 0.95;
                ctx.fillStyle = '#FFFFFF';
                ctx.beginPath();
                ctx.arc(shell.ax, shell.ay, 6 + 26 * (bt / 0.12), 0, Math.PI * 2);
                ctx.fill();
            }
            if (bt > LIFE) continue;

            const fade = 1 - bt / LIFE;
            // 带指数阻力的水平衰减 + 重力下坠
            const step = (1 - Math.exp(-DRAG * bt)) / DRAG;
            for (const p of shell.particles) {
                const twinkle = 0.6 + 0.4 * Math.sin(bt * 24 + p.phase);
                const x = shell.ax + Math.cos(p.angle) * p.speed * step;
                const y = shell.ay + Math.sin(p.angle) * p.speed * step + 0.5 * GRAVITY * bt * bt;
                ctx.globalAlpha = Math.max(0, fade * twinkle);
                ctx.strokeStyle = shell.color;
                ctx.lineWidth = 2.2 * fade + 0.4;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x - Math.cos(p.angle) * 5 * fade, y - Math.sin(p.angle) * 5 * fade);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    /* ---------------- 蓄能器定位 ---------------- */

    /** 由 Game 注入蓄能器 DOM 元素，用于计算光团飞行目标在画布上的坐标 */
    setAccumulatorElement(el) {
        this._accumulatorEl = el;
    }

    /**
     * 把蓄能器 DOM 元素的屏幕位置换算成 canvas 内部坐标。
     * 考虑 CSS 响应式缩放（canvas 有 max-width:100% + height:auto）；
     * 目标 clamp 到画布边缘，避免光团飞出可视区域。
     */
    getAccumulatorCanvasPos() {
        if (!this._accumulatorEl || !this.canvas) return null;
        const aRect = this._accumulatorEl.getBoundingClientRect();
        const cRect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / cRect.width;
        const scaleY = this.canvas.height / cRect.height;
        const rawX = (aRect.left + aRect.width / 2 - cRect.left) * scaleX;
        const rawY = (aRect.top + aRect.height / 2 - cRect.top) * scaleY;
        return {
            x: Math.max(10, Math.min(this.canvas.width - 10, rawX)),
            y: Math.max(10, Math.min(this.canvas.height - 10, rawY)),
        };
    }

    /* ---------------- 光团粒子系统 ---------------- */

    /**
     * 做功（产生动能）：金色光团从球飞入储能罐，罐体金黄脉冲并浮现 "+X J"
     * @param {number} x  释放点 X
     * @param {number} y  释放点 Y
     * @param {number} power  本次释放的功 (J)
     */
    spawnWorkOrbs(x, y, power) {
        const target = this.getAccumulatorCanvasPos();
        if (!target) return;

        this.pulseTank('in');
        this.addTankFlash(`+${power.toFixed(0)} J`, '#FFC14D', 0.55);

        const count = Math.min(14, Math.max(5, Math.round(Math.sqrt(power / 15))));
        for (let i = 0; i < count; i++) {
            const delay = i * 0.055;
            const perpAngle = Math.random() * Math.PI * 2;
            const offset = 22 + Math.random() * 34;
            this.orbs.push({
                startX: x, startY: y,
                x, y,
                targetX: target.x, targetY: target.y,
                ctrlX: (x + target.x) / 2 + Math.cos(perpAngle) * offset,
                ctrlY: (y + target.y) / 2 + Math.sin(perpAngle) * offset - 30,
                progress: -delay,
                duration: 0.6 + Math.random() * 0.25,
                size: 4 + Math.sqrt(power) * 0.16,
                color: '#FFC14D',
                trailColor: 'rgba(255, 193, 77, 0.6)',
                type: 'work',
                phase: Math.random() * Math.PI * 2,
            });
        }
    }

    /**
     * 摩擦（消耗动能）：橙红光团从储能罐飞向球，罐体红脉冲并浮现 "−X J"（支出）
     * @param {number} x  消耗发生点 X
     * @param {number} y  消耗发生点 Y
     * @param {number} work  本次摩擦功 (J)
     */
    spawnFrictionOrbs(x, y, work) {
        const source = this.getAccumulatorCanvasPos();
        if (!source) return;

        this.pulseTank('out');
        this.addTankFlash(`−${work.toFixed(1)} J`, '#FF5A5F', 0.15);

        const count = Math.min(5, Math.max(2, Math.round(Math.sqrt(work / 40))));
        for (let i = 0; i < count; i++) {
            const perpAngle = Math.random() * Math.PI * 2;
            const offset = 16 + Math.random() * 26;
            const jitter = () => (Math.random() - 0.5) * 18;
            this.orbs.push({
                startX: source.x, startY: source.y,
                x: source.x, y: source.y,
                targetX: x + jitter(),
                targetY: y + jitter(),
                ctrlX: (source.x + x) / 2 + Math.cos(perpAngle) * offset,
                ctrlY: (source.y + y) / 2 + Math.sin(perpAngle) * offset,
                progress: -i * 0.05,
                duration: 0.5 + Math.random() * 0.2,
                size: 2.6 + Math.sqrt(work) * 0.1,
                color: '#FF8A65',
                trailColor: 'rgba(255, 95, 65, 0.5)',
                type: 'friction',
                phase: Math.random() * Math.PI * 2,
            });
        }
    }

    /** 每帧推进所有光团粒子 */
    updateOrbs(dt) {
        for (const orb of this.orbs) {
            orb.progress += dt / orb.duration;
            const t = Math.max(0, Math.min(1, orb.progress));
            const mt = 1 - t;
            orb.x = mt * mt * orb.startX + 2 * mt * t * orb.ctrlX + t * t * orb.targetX;
            orb.y = mt * mt * orb.startY + 2 * mt * t * orb.ctrlY + t * t * orb.targetY;
        }
        this.orbs = this.orbs.filter(o => o.progress < 1);
    }

    /** 绘制全部光团粒子 */
    drawOrbs() {
        const ctx = this.ctx;
        ctx.save();
        for (const orb of this.orbs) {
            if (orb.progress < 0) continue;
            const t = orb.progress;
            let fade = 1;
            if (t < 0.15) fade = t / 0.15;
            else if (t > 0.7) fade = 1 - (t - 0.7) / 0.3;
            else fade = 1;

            // 外层辉光
            ctx.globalAlpha = fade * 0.28;
            ctx.fillStyle = orb.color;
            ctx.beginPath();
            ctx.arc(orb.x, orb.y, orb.size * 2.8, 0, Math.PI * 2);
            ctx.fill();

            // 中层光晕
            ctx.globalAlpha = fade * 0.55;
            ctx.beginPath();
            ctx.arc(orb.x, orb.y, orb.size * 1.4, 0, Math.PI * 2);
            ctx.fill();

            // 内核亮点
            ctx.globalAlpha = fade * 0.95;
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(orb.x, orb.y, orb.size * 0.45, 0, Math.PI * 2);
            ctx.fill();

            // 尾迹
            if (t > 0.04) {
                const pt = Math.max(0, t - 0.06);
                const mt2 = 1 - pt;
                const px = mt2 * mt2 * orb.startX + 2 * mt2 * pt * orb.ctrlX + pt * pt * orb.targetX;
                const py = mt2 * mt2 * orb.startY + 2 * mt2 * pt * orb.ctrlY + pt * pt * orb.targetY;
                ctx.globalAlpha = fade * 0.35;
                ctx.strokeStyle = orb.trailColor;
                ctx.lineWidth = orb.size * 0.7;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(px, py);
                ctx.lineTo(orb.x, orb.y);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    /* ---------------- 合并特效 ---------------- */

    /**
     * 合并时：显示两球可用能之和的减少量，一个光团飞出后消失
     * @param {number} x1  球A x
     * @param {number} y1  球A y
     * @param {number} x2  球B x
     * @param {number} y2  球B y
     * @param {number} exergyDestroyed  㶲损 (J)
     * @param {number} exA  球A 合并前的可用能
     * @param {number} exB  球B 合并前的可用能
     */
    addMergeEffect(x1, y1, x2, y2, exergyDestroyed, exA, exB) {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.8;
        const speed = 85 + Math.random() * 45;
        this.mergeEffects.push({
            cx, cy,
            exergyDestroyed,
            exA, exB,
            orbX: cx, orbY: cy,
            orbAngle: angle,
            orbSpeed: speed,
            life: 1,
            duration: 1.5,
            textY: cy - 22,
        });
        if (this.mergeEffects.length > 12) this.mergeEffects.shift();
    }

    /** 每帧推进合并特效 */
    updateMergeEffects(dt) {
        for (const e of this.mergeEffects) {
            e.life -= dt / e.duration;
            const t = 1 - e.life;
            e.orbX += Math.cos(e.orbAngle) * e.orbSpeed * dt;
            e.orbY += Math.sin(e.orbAngle) * e.orbSpeed * dt;
            e.textY -= 22 * dt;
        }
        this.mergeEffects = this.mergeEffects.filter(e => e.life > 0);
    }

    /** 绘制合并特效：浮动文字 + 飞离光团 */
    drawMergeEffects() {
        const ctx = this.ctx;
        ctx.save();
        for (const e of this.mergeEffects) {
            const fade = Math.max(0, e.life);
            const pop = e.life > 0.82 ? (1 - e.life) / 0.18 : 1;

            // 可用能减少浮动文字
            ctx.globalAlpha = fade * pop;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '700 14px "Noto Sans", Arial, sans-serif';
            ctx.fillStyle = '#FF5A5F';
            ctx.fillText(`可用能 -${e.exergyDestroyed.toFixed(0)} J`, e.cx, e.textY);

            // 两球原有可用能标注
            ctx.font = '500 10px "Noto Sans", Arial, sans-serif';
            ctx.fillStyle = 'rgba(255, 193, 77, 0.85)';
            ctx.fillText(`${e.exA.toFixed(0)} + ${e.exB.toFixed(0)} → 合并`, e.cx, e.textY + 17);

            // 飞离的光团（代表被销毁的㶲）
            if (fade > 0.05) {
                ctx.globalAlpha = fade * 0.85;
                ctx.fillStyle = '#FF5A5F';
                ctx.beginPath();
                ctx.arc(e.orbX, e.orbY, 4.5 * fade + 1.5, 0, Math.PI * 2);
                ctx.fill();

                ctx.globalAlpha = fade * 0.3;
                ctx.fillStyle = '#FF8A65';
                ctx.beginPath();
                ctx.arc(e.orbX, e.orbY, 10 * fade + 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    /* ---------------- 摩擦耗散热 ---------------- */

    /** 拖拽摩擦排给环境的热量：向外扩散一圈冷色光环后消散 */
    addDissipation(x, y, r) {
        this.dissipations.push({ x, y, r, life: 1 });
        if (this.dissipations.length > 40) this.dissipations.shift();
    }

    updateDissipations(dt) {
        if (this.dissipations.length === 0) return;
        for (const d of this.dissipations) d.life -= dt / 0.55;
        this.dissipations = this.dissipations.filter((d) => d.life > 0);
    }

    drawDissipations() {
        const ctx = this.ctx;
        ctx.save();
        for (const d of this.dissipations) {
            const p = 1 - d.life;
            ctx.globalAlpha = d.life * 0.5;
            ctx.strokeStyle = '#4DD0E1';
            ctx.lineWidth = 2 * d.life + 0.4;
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.r + p * 22, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ---------------- 储能罐 ---------------- */

    /**
     * 更新储能罐液位动画值，平滑逼近目标填充比
     * @param {number} dt  帧间隔（秒）
     * @param {number} targetRatio  目标填充比 (0~1)
     */
    updateTank(dt, targetRatio) {
        const target = Math.max(0, Math.min(1, targetRatio));
        // 平滑插值，每帧逼近目标
        const speed = 5;
        const factor = 1 - Math.exp(-speed * dt);
        this._tankFill += (target - this._tankFill) * factor;
    }

    /** 注入储能罐 DOM（罐体 / 液位 / 读数），储能罐位于迷宫之外 */
    setTankElements(tankEl, liquidEl, valueEl) {
        this._tankEl = tankEl || null;
        this._tankLiquidEl = liquidEl || null;
        this._tankValueEl = valueEl || null;
    }

    /** 能量流向提示：'in' 充入（做功）/ 'out' 支出（摩擦） */
    pulseTank(mode) {
        const el = this._tankEl;
        if (!el || !el.classList) return;
        el.classList.remove('flow-in', 'flow-out');
        void el.offsetWidth;
        el.classList.add(mode === 'in' ? 'flow-in' : 'flow-out');
        clearTimeout(this._tankFlowTimer);
        this._tankFlowTimer = setTimeout(() => {
            if (this._tankEl && this._tankEl.classList) {
                this._tankEl.classList.remove('flow-in', 'flow-out');
            }
        }, 800);
    }

    /**
     * 把液位与读数同步到储能罐 DOM
     * @param {number} accumulatorValue  蓄能器余额 (J)
     * @param {number} maxAccumulator    参考满量程 (J)
     */
    updateTankDom(accumulatorValue, maxAccumulator) {
        if (this._tankLiquidEl) {
            this._tankLiquidEl.style.height = `${(Math.max(0, Math.min(1, this._tankFill)) * 100).toFixed(1)}%`;
        }
        if (this._tankValueEl) {
            const text = `${accumulatorValue.toFixed(0)} J`;
            if (this._tankValueEl.textContent !== text) this._tankValueEl.textContent = text;
            this._tankValueEl.classList.toggle('is-negative', accumulatorValue < 0);
        }
    }

    /** 罐体旁的流入 / 流出读数 */
    addTankFlash(text, color, delay = 0) {
        this.tankFlashes.push({ text, color, life: 1, delay });
        if (this.tankFlashes.length > 8) this.tankFlashes.shift();
    }

    updateTankFlashes(dt) {
        for (const f of this.tankFlashes) {
            if (f.delay > 0) {
                f.delay -= dt;
                continue;
            }
            f.life -= dt / 0.9;
        }
        this.tankFlashes = this.tankFlashes.filter((f) => f.life > 0);
    }

    /** 在罐体边缘绘制 "+X J / −X J"，配合光团明确表达能量收支 */
    drawTankFlashes() {
        const pos = this.getAccumulatorCanvasPos();
        if (!pos) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        for (const f of this.tankFlashes) {
            if (f.delay > 0) continue;
            const rise = (1 - f.life) * 26;
            const alpha = Math.max(0, Math.min(1, f.life));
            ctx.globalAlpha = alpha;
            ctx.font = '700 13px "Noto Sans", Arial, sans-serif';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(6, 9, 14, 0.85)';
            ctx.strokeText(f.text, pos.x - 6, pos.y - 20 - rise);
            ctx.fillStyle = f.color;
            ctx.fillText(f.text, pos.x - 6, pos.y - 20 - rise);
        }
        ctx.restore();
    }

    /* ---------------- 主绘制 ---------------- */

    /**
     * @param {object} state - {blocks, selected, carry, preview, mergePreview, time, dt}
     */
    draw(state) {
        const dt = state.dt || 0;
        this.updateDissipations(dt);
        this.updateOrbs(dt);
        this.updateMergeEffects(dt);

        // 更新储能罐液位动画：余额由 Game 注入，罐体本身是迷宫之外的 DOM 面板
        const accValue = Number.isFinite(state.accumulator) ? state.accumulator : 0;
        // 动态参考最大值：取历史峰值的 1.2 倍，保证液位始终在可视范围内有意义
        this._tankMax = Math.max(this._tankMax || 1000, Math.abs(accValue) * 1.2, 500);
        this.updateTank(dt, accValue / this._tankMax);
        this.updateTankDom(accValue, this._tankMax);
        this.updateTankFlashes(dt);

        this.ensureStatic();
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(this.staticLayer, 0, 0);

        if (this.showGrid) this.drawGrid();
        if (this.showCenterline) this.drawCenterlines();

        const time = state.time || 0;

        this.drawDissipations();

        if (state.carry) this.drawCarryPreview(state.carry);

        const highlighted = state.mergePreview
            ? new Set([state.mergePreview.a, state.mergePreview.b])
            : null;

        const carriedBlock = state.carry ? state.carry.block : null;

        // 非被拾取的球：画在各自的通道位置上
        for (const block of state.blocks) {
            if (block.hidden || block === carriedBlock) continue;
            this.drawOrb(block, {
                highlighted: highlighted ? highlighted.has(block) : false,
                time,
            });
        }

        if (state.mergePreview) {
            this.drawMergeLink(
                state.mergePreview.a,
                state.mergePreview.b,
                time,
                state.carry && state.mergePreview.a === carriedBlock ? state.carry.free : null
            );
        }

        // 被拾取的球最后画：跟随指针的自由位置，压在所有球之上
        if (carriedBlock && !carriedBlock.hidden) {
            this.drawOrb(carriedBlock, {
                x: state.carry.free.x,
                y: state.carry.free.y,
                selected: true,
                highlighted: highlighted ? highlighted.has(carriedBlock) : false,
                time,
            });
        }

        for (const anim of this.animations) {
            anim.time = time;
            if (anim.type === 'explosion') this.drawExplosionFrame(anim);
            else if (anim.type === 'fireworks') this.drawFireworksFrame(anim);
            else this.drawAnimationFrame(anim);
        }

        // 光团粒子与合并特效画在最上层
        this.drawOrbs();
        this.drawMergeEffects();
        // 能量流入 / 流出储能罐的浮动读数
        this.drawTankFlashes();

        if (state.carry) this.drawPreviewPanel(state.preview, state.carry);
    }
}
