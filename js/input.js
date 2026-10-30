/**
 * 输入处理 —— 点击拾取 → 自由移动 → 再次点击确认
 *
 * 交互模型（与"按住拖拽"的区别）：
 *   1. 点击一颗球 → 拾取，此后球附着在指针上自由移动（可脱离通道，仅视觉跟随）
 *   2. 移动期间不产生任何物理过程，只刷新"若此刻确认会发生什么"的预览
 *   3. 再次点击 → 确认，此时才真正沿通道推进、累计摩擦耗散并触发合并
 *
 * 按下时记录「抓取偏移」= 指针位置 − 圆心位置，
 * 这样点击大球边缘时圆心不会瞬间跳到指针正下方。
 *
 * 本类只负责把指针换算成画布像素坐标并转发给 Game，
 * 投影、寻路与物理全部由 Game + CorridorNetwork + PhysicsEngine 完成。
 */
class InputHandler {
    /** 双击（连击两次）的时间窗（毫秒） */
    static DOUBLE_TAP_MS = 350;
    /** 双击容许的落点偏移（画布像素） */
    static DOUBLE_TAP_PX = 24;

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Game} game
     */
    constructor(canvas, game) {
        this.canvas = canvas;
        this.game = game;

        this.activePointerId = null;
        /** 上一次点击命中信息，用于双击判定 */
        this.lastTap = null;

        this.bindEvents();
    }

    bindEvents() {
        this.canvas.addEventListener('click', this.onClick.bind(this));
        this.canvas.addEventListener('mousedown', (e) => {
            // 仅用于抑制拖拽时的文本选中，不改变任何交互语义
            if (e.button === 0) e.preventDefault();
        });
        window.addEventListener('mousemove', this.onMouseMove.bind(this));

        this.canvas.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        this.canvas.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        window.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false });
        window.addEventListener('touchcancel', this.onTouchEnd.bind(this), { passive: false });
    }

    /**
     * 客户端坐标 → 画布像素坐标（自动处理 CSS 缩放）
     */
    toCanvasPoint(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = rect.width === 0 ? 1 : this.canvas.width / rect.width;
        const sy = rect.height === 0 ? 1 : this.canvas.height / rect.height;
        return {
            x: (clientX - rect.left) * sx,
            y: (clientY - rect.top) * sy,
        };
    }

    /** 当前时间（毫秒），用于双击判定 */
    static nowMs() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
    }

    /**
     * 一次「点击」：双击某颗球则直接让它做功；否则未拾取则拾取，已拾取则确认
     *
     * 双击判定：短时间内（≤350 ms）、落点几乎没动（≤24 px）地再次点到同一颗球。
     * 第一次点击已经把它拾起，所以命中时先解除拾取再释放，不会残留拖拽预览。
     */
    tap(px, py) {
        const game = this.game;
        const now = InputHandler.nowMs();
        const hit = game.pickBlockAt(px, py);

        const prev = this.lastTap;
        const isDouble = !!hit && !!prev && prev.block === hit
            && now - prev.time <= InputHandler.DOUBLE_TAP_MS
            && Math.hypot(px - prev.x, py - prev.y) <= InputHandler.DOUBLE_TAP_PX;

        if (isDouble) {
            this.lastTap = null;
            game.releaseWork(hit);   // 就让这颗球做功，而不是可用能最大的那颗
            return;
        }

        this.lastTap = hit ? { block: hit, time: now, x: px, y: py } : null;

        if (game.carrying) {
            game.confirmCarry();
            return;
        }
        if (!hit) return;
        game.pickUp(hit, px, py);
    }

    /* ---------------- 鼠标 ---------------- */

    onClick(e) {
        const p = this.toCanvasPoint(e.clientX, e.clientY);
        this.tap(p.x, p.y);
    }

    onMouseMove(e) {
        if (!this.game.carrying) return;
        const p = this.toCanvasPoint(e.clientX, e.clientY);
        this.game.updateCarry(p.x, p.y);
    }

    /* ---------------- 触摸 ---------------- */

    onTouchStart(e) {
        const touch = e.changedTouches[0] || e.touches[0];
        if (!touch) return;
        e.preventDefault();
        if (this.activePointerId !== null) return; // 忽略多指

        this.activePointerId = touch.identifier;
        const p = this.toCanvasPoint(touch.clientX, touch.clientY);
        this.tap(p.x, p.y);
    }

    onTouchMove(e) {
        if (!this.game.carrying) return;
        const touch = this.findTouch(e.touches);
        if (!touch) return;
        e.preventDefault();
        const p = this.toCanvasPoint(touch.clientX, touch.clientY);
        this.game.updateCarry(p.x, p.y);
    }

    /** 抬指：只清指针标识，不触发任何操作（点击语义已在 touchstart 完成） */
    onTouchEnd() {
        this.activePointerId = null;
    }

    findTouch(touches) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === this.activePointerId) return touches[i];
        }
        return null;
    }
}
