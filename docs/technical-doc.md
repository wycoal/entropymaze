# Entropy Maze - 技术开发文档（v2）

> v2 把游戏从「整格墙 + 方形图块 + 跳格移动」重构为
> 「随机完美迷宫（生成树）+ 薄墙 + 通道中心线网络 + 圆形能量球」。
> 本文描述当前实现，v1 的 0/1 占据数组模型已废弃。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────┐
│  main.js   配置 GAME_CONFIG / 种子随机源 / 快捷键 / debug
└──────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│  game.js   Game：世界构建 / rAF 主循环 / 拾取预览与确认 /
│            摩擦累计 / 相触合并 / 统计拆分 / 结束判定
└──────────────────────────────────────────────┘
        ↓            ↓            ↓           ↓
┌──────────────┐ ┌─────────┐ ┌──────────┐ ┌────────┐
│ maze.js      │ │corridor │ │physics.js│ │renderer│
│ 完美迷宫生成树│ │.js      │ │ 热力学   │ │.js     │
│ + 薄墙清单   │ │中心线网络│ │          │ │Canvas  │
└──────────────┘ └─────────┘ └──────────┘ └────────┘
        ↓                                      ↓
┌──────────────┐                       ┌──────────────┐
│ block.js     │                       │ input.js     │
│ 质点+圆形体积 │                       │ 指针 → Game  │
└──────────────┘                       └──────────────┘
                       ↓
                ┌────────────┐
                │  ui.js     │  统计面板 / 控制面板 / 消息 / 结算
                └────────────┘
```

数据流：

```
指针事件 → InputHandler 换算画布坐标（扣除抓取偏移）
        → Game 投影到通道中心线得到目标点
        → CorridorNetwork 构建树上唯一路径折线
        → 主循环逐帧沿折线推进圆心（累计真实路径长度）
        → PhysicsEngine 累计熵产与㶲损；相触则合并
        → Renderer 绘制 → UIManager 刷新统计
```

---

## 2. 文件清单

| 文件 | 类 | 职责 |
|---|---|---|
| `js/main.js` | — | `GAME_CONFIG`、`createSeededRandom`、快捷键、 `window.debug` |
| `js/maze.js` | `Maze` | 随机完美迷宫（生成树）、薄墙矩形清单、格心坐标、自检 |
| `js/corridor.js` | `CorridorNetwork` | 中心线线段集合、点投影、树上寻路、折线推进、路径距离 |
| `js/block.js` | `EnergyBlock` | 圆心参数位置 `{segIdx,t}`、半径、温度灰度、命中/相触判定 |
| `js/physics.js` | `PhysicsEngine` | 内能/熵/㶲、摩擦耗散、合并传热、温度分配 |
| `js/renderer.js` | `Renderer` | 静态层（底色+薄墙）、中心线、能量球、拾取预览与增量浮层、合并动画 |
| `js/input.js` | `InputHandler` | 鼠标/触摸、抓取偏移、坐标换算 |
| `js/game.js` | `Game` | 主控：世界构建、主循环、拾取预览、确认执行、合并、统计、结束 |
| `js/ui.js` | `UIManager` | 统计卡片、滑块、做功按钮、消息、结算浮层 |

加载顺序见 `index.html`：`block → maze → corridor → physics → renderer → input → ui → game → main`。

---

## 3. 迷宫：随机完美迷宫（生成树）

### 3.1 数据结构

```js
Maze {
    cols, rows, pitch, wallThickness,
    originX, originY,      // = wallThickness/2，让外墙完整落在画布内
    width,  height,        // = cols*pitch + wallThickness（画布尺寸由几何推导）
    cellCount,             // = cols*rows
    edges,                 // 树边 [{a, b}]，a/b 为格心下标
    passages,              // Set<"min_max">，O(1) 判断两格心之间是否有通道
    walls,                 // 薄墙矩形 [{x,y,w,h}]
}
```

### 3.2 生成算法：迭代式随机化 DFS

```js
栈 = [随机起点]; 标记已访问
while (栈非空):
    cur = 栈顶
    候选 = cur 的未访问四邻居
    if 候选为空: 出栈; continue
    next = 候选中的随机一个
    加边 (cur, next); 标记 next; 入栈
```

每加一条边都连接"已访问 ↔ 未访问"，因此**不可能成环**；遍历结束覆盖全部格心，因此**必然连通**。
结果是生成树，边数 = `cellCount − 1 = 251`。

`Maze.validate()` 给出 `{isConnected, isAcyclic, nodeCount, edgeCount}` 供自检。

### 3.3 薄墙的绘制

墙不再是整格填充，而是画在**网格线**上的细长矩形：

- 竖墙（第 c 列右侧无通道）：`x = gridLineX(c+1) − t/2`，`宽 = t`，`高 = pitch + t`
- 横墙（第 r 行下方无通道）：`y = gridLineY(r+1) − t/2`，`高 = t`，`宽 = pitch + t`
- 长度两端各外扩 `t/2`，拐角自然封口，无需额外补块
- 四条外边界恒为墙

默认 `pitch = 40`、`wallThickness = 8`，通道净宽 `40 − 8 = 32 px`。

---

## 4. 通道中心线网络

### 4.1 结构

每条树边 → 一条「格心 ↔ 相邻格心」的轴对齐线段：

```js
segments[i] = { a, b, ax, ay, bx, by, len }
adjacency[node] = [{node, seg}, ...]     // 供树上 BFS
```

能量球的圆心位置**不存像素**，而存 `{segIdx, t}`：

```js
pos = { segIdx: 12, t: 0.37 }            // 第 12 条线段上 37% 处
```

像素圆心由 `pointAt(segIdx, t)` 派生并缓存到 `block.x / block.y`。
这使"圆心只能沿通道中心线移动"成为**结构性保证**，而非运行时校验。

### 4.2 关键算法

| 方法 | 说明 | 复杂度 |
|---|---|---|
| `projectPoint(px,py)` | 遍历全部线段取最近投影，返回 `{segIdx,t,x,y,dist}` | O(S)，S≈251 |
| `treePathNodes(a,b)` | 树上 BFS 求唯一节点路径 | O(N)，N=252 |
| `buildPath(fromPos,toPos)` | 起点/终点各两个端点共 4 种组合取最短；**同线段时直接走直线** | O(4N) |
| `advance(path, traveled, step)` | 沿折线推进并把新点解析回 `{segIdx,t}` | O(S) |
| `pathDistance(a,b)` | 两位置沿通道的实际距离（用于"禁止隔墙合并"选项） | O(4N) |

> 注意：同线段时若也走端点组合会得到 `(t₁+t₂)·len` 的错误结果，
> 必须单独处理为 `|t₂−t₁|·len`。

---

## 5. 能量球：质点 + 圆形体积

```js
EnergyBlock {
    id, mass, temperature,          // 温度对外为摄氏度
    radiusUnit,                     // radius = radiusUnit * sqrt(mass)
    radius,                         // 圆面积 ∝ 质量
    pos: {segIdx, t},               // 圆心在中心线上的参数位置
    x, y,                           // 派生像素圆心（缓存）
    grayValue, color,               // 温度 → 灰度：0°C 黑，300°C 白
    internalEnergy, entropy, exergy // 由 physics.summarize() 每帧写回
    hidden                          // 合并动画播放期间隐藏，避免重影
}
```

- 半径默认 11.0 ~ 16.5 px（质量 4~9），合并后不断膨胀，终态约 55 px
- 通道半宽仅 16 px → 大球必然**溢出通道、压在薄墙上**
- 渲染时球画在墙之后且**不做任何裁剪**，因此溢出是默认行为而非例外
- `touches(other)`：`dist(c₁,c₂) ≤ r₁+r₂`（欧氏，允许隔墙相触）

---

## 6. 交互：点击拾取 → 移动预览 → 点击确认

> 与"按住拖拽"的根本区别：**拾取与移动期间不产生任何物理过程**。
> 球的真实位置 `block.pos` 保持不变，只做增量预览；只有确认时才写入真实状态。

### 6.1 拾取（`pickUp`）

1. `click` / `touchstart`：`pickBlockAt` 命中球 → 建立 `carrying` 会话
   - `grab = 指针 − 圆心`：点击大球边缘时圆心不会跳到指针正下方
   - `free`：允许脱离通道的自由圆心（**仅视觉**）
   - `target` / `targetPos`：`free` 投影到通道中心线的落点
2. `mousemove` / `touchmove`：只更新 `free`、`target` 与预览，**不动 `block.pos`**
   - 指针距网络 > `0.95·pitch` 时准星转红（`valid = false`）
   - 用 `block.pos` → `targetPos` 重建行进折线（`buildPath`，走树的唯一通路）

### 6.2 预览（`updatePreview`，纯计算）

`physics.applyFriction` 与 `physics.merge` 都是纯函数，可安全用于预演：

| 预览项 | 来源 |
|---|---|
| 移动距离 | `path.length / pixelsPerMeter` |
| 摩擦耗散 / 熵产 / 㶲损 | `applyFriction(block, meters)` |
| 是否将合并 | 以 `target` 为圆心判断相触（含隔墙判定） |
| 合并后温度 / 质量 | `physics.merge` |

结果渲染成跟随球的「确认后的变化」浮层。

### 6.3 确认（`confirmCarry`，此刻才发生物理过程）

```js
advanceAlongPath(carrying, path.length)   // 沿通道真实推进 → 累计 travelDistance / 摩擦耗散
tryMerge(block)                           // 落点处相触即合并
cancelCarry() + updateStatistics()
```

`Esc` / 新局 / 游戏结束 → `cancelCarry()`，丢弃本次拾取，不产生任何变化。

`touchstart/move` 用 `preventDefault()` 并配 `touch-action: none`，避免移动端页面滚动。

### 6.4 做功（`releaseWork`，按钮 / `W` 键）

暂停按钮已移除，控制面板第三个按钮改为「做功」。它**只作用于一颗球**：当前可用能最大的单体。

```js
releaseWork():
    target = argmax(exergy)                    // 只挑一颗，其余球完全不动
    W = target.exergy                          // 可逆放出：全部㶲 → 功
    U = target.internalEnergy
    target.temperature = backgroundTemp        // 落到死态：U = S = E = 0
    stats.workExtracted += W
    stats.heatRejected  += U − W               // === T0 · S
    renderer.addExplosion({x, y, r, power: W}) // 爆炸规模 ∝ √W
```

| 量 | 变化 |
|---|---|
| 该球温度 | `T → T₀`（死态），质量与半径不变 |
| 该球内能 / 熵 / 㶲 | 全部归零 |
| 累计做功 | `+= E` |
| 累计排热 | `+= U − E = T₀·S` |
| 累计熵产 | **不变**（可逆释放，不产生熵） |
| 其余球 | **完全不动** |

由此得到两条可校验的恒等式（`window.debug.verify()`）：

```
剩余内能 + 累计做功 + 累计排热 = 初始内能（10000 J）
ΔE = ΔU − T0·ΔS_sys          // 做功使 ΔU ≠ 0，这是广义形式
```

未做功时 `ΔU = 0`，上式退化为 `ΔE = −T₀·ΔS_sys`（即"可用能下降 = T₀ × 系统熵增"）。

> 因此做功后「总内能」卡片会下降，这是正确的：那部分内能被取出为功并排热，不再是球的内能。

---

## 7. 主循环

```js
tick(ts):
    requestAnimationFrame(tick)             // 先排下一帧：单帧异常不会让循环永久停摆
    try:
        dt = min(max((ts - lastTs)/1000, 0), 0.05)
        if (!paused):
            if (!gameOver): update(dt)      // 只推进动画与统计
            updateAnimations(dt)            // 即使已结束也要推进，否则最后一球永远 hidden
        render(dt)
    catch: console.error(...)
```

> 移动与合并**不在主循环里**：它们只由 `confirmCarry()` 触发，
> 因此不存在"主循环停摆导致球拖不动"的可能。

`update(dt)` 内：

```
updateAnimations(dt)    // 推进合并动画进度，结束时解除 hidden
updateStatistics()      // 瞬时量重算 + UI 刷新 + 结束判定
```

---

## 8. 合并流程

```js
mergeBlocks(a, b):
    result = physics.merge(a, b)          // Tf、新质量、熵产、㶲损
    merged = new EnergyBlock(newMass, Tf)
    merged.pos = a.pos                    // 落在 a 的原位置
    merged.hidden = true                  // 动画期间不参与常规绘制
    从 blocks 移除 a、b，加入 merged
    stats.mergeCount++
    stats.entropyGenerated += result.entropyGenerated
    stats.exergyDestroyed  += result.exergyDestroyed
    renderer.addMergeAnimation({a快照, b快照, target: merged})
```

动画（0.45 s）：旧球收缩淡出 → 新球放大淡入 → 琥珀色光环向外扩散。

---

## 9. 统计字段（累计量 / 瞬时量分离）

| 字段 | 类型 | 含义 |
|---|---|---|
| `totalEnergy` | 瞬时 | 系统总内能，初始 10000 J；**做功后会下降**（能量被取出） |
| `currentExergy` | 瞬时 | 当前可用能 |
| `systemEntropy` | 瞬时 | 系统熵 Σ mc·ln(T/T₀) |
| `maxExergy` | 累计 | 可用能峰值（㶲单调下降，即初始值） |
| `exergyDestroyed` | 累计 | 累计㶲损（**只含合并传热**，不含摩擦、不含做功） |
| `entropyGenerated` | 累计 | 累计熵产（**只含合并传热**；摩擦不再计入，做功不产生熵） |
| `frictionWork` | 累计 | 累计摩擦功（只用于扣减蓄能器） |
| `workExtracted` | 累计 | 累计做功：只累计能量单元释放的功（能量预算用） |
| `accumulator` | 累计 | **蓄能器余额 = 初始储能 + workExtracted − frictionWork**；可由滑块调整初值 0–1000 J，为负时禁止移动 |
| `unitExergy` | 瞬时 | **单元可用能**：系统里单个能量单元可用能的最大值 —— **胜利判据 / 本局成绩**，超过 300 J 显示胜利色 |
| `peakWork` | 峰值 | 单次做功的最大值（做功峰值，只增不减）—— 参考值，不会超过单元可用能 |
| `peakWorkRatio` | 比值 | 做功峰值 / 累计做功 —— **参考比值**（非判据），越大越"集中"；尚未释放过功时不显示数值 |
| `heatRejected` | 累计 | 累计排给环境的热（做功时 `= T₀·S`） |
| `travelDistance` | 累计 | 沿通道实际行进距离（米） |
| `dragCount` | 累计 | 拾取次数 |
| `mergeCount` | 累计 | 合并次数 |
| `initialExergy` | 基准 | 每局开始时的可用能，用作做功占比分母 |
| `initialEntropy` | 基准 | 每局开始时的系统熵，用于㶲平衡自检 |

> 能量预算：`totalEnergy + workExtracted + heatRejected` 恒等于初始内能 10000 J（用毛值 `workExtracted`）。
>
> 㶲平衡（新口径，摩擦已移出 `I` 与 `ΔS_gen`）：
> `初始可用能 − 当前可用能 = workExtracted + exergyDestroyed`。
> `exergyDestroyed = T₀ · entropyGenerated` 仍然严格成立（两者都只含合并传热）。

> v1 的 bug：`stats.totalEntropy = calculateTotalEntropy(...)` 是赋值，会覆盖掉 `+=` 累加的熵增。
> v2 用两个互不干扰的字段彻底分离。

---

## 10. 配置参数（`js/main.js`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `mazeCols / mazeRows` | 18 / 14 | 格心数 |
| `pitch` | 40 | 格心间距（px），同时 = 1 米 |
| `wallThickness` | 8 | 薄墙厚度（px） |
| `blockCount` | 15 | 能量球数量 |
| `minBlockMass / maxBlockMass` | 4 / 9 | 质量区间（决定半径 11~16.5 px） |
| `radiusUnit` | 5.5 | `radius = radiusUnit·√mass` |
| `spawnGap` | 8 | 初始散布额外间距，防开局自动合并 |
| `backgroundTemperature` | 20 | 环境温度 T₀（°C），同时为温度下限 |
| `accumulatorInitial` | 500 | 蓄能器初始储能（J），滑块可调 0–1000；余额不足移动摩擦时禁止移动 |
| `unitExergyGoal` | 300 | 单元可用能达标线（J）；超过则「单元可用能」卡显示胜利色 |
| `maxTemperature` | 300 | 温度上限（映射到纯白） |
| `totalEnergy` | 10000 | 系统总内能（J） |
| `frictionCoefficient` | 0.15 | 摩擦系数 μ，滑块可调 `0–0.30`；取 0 时移动不消耗蓄能器 |
| `pixelsPerMeter` | 40 | 与 pitch 一致 |

| `mergeAnimDuration` | 0.45 | 合并动画时长（s） |
| `mergeAcrossWalls` | true | 是否允许隔着薄墙相触即合 |
| `showCenterline` | true | 通道中心线虚线 |
| `showGrid` | true | 网格辅助线 |
| `showTemperature` | true | 球上标注温度 |
| `showExergy` | true | 球上标注可用能 |

> 四个显示项默认全部开启，且**不提供界面开关**：界面只保留按钮与两个滑块，
> 需要调整时直接改 `GAME_CONFIG`。

---

## 11. 随机种子

`createSeededRandom(seed)` 为 mulberry32（零依赖）：

- 「新游戏」取新随机种子 → 生成新迷宫 + 新球
- 「重置」复用当前种子 → 复现同一座迷宫与同一批球

---

## 12. 渲染分层与性能

| 层 | 内容 | 策略 |
|---|---|---|
| 静态层 | 底色渐变 + 全部薄墙 | 离屏 canvas 缓存，仅重建迷宫时重绘 |
| 辅助层 | 网格线、通道中心线虚线 | 每帧绘制（251 条线，开销可忽略） |
| 动态层 | 能量球、拾取预览（路径/落点/增量浮层）、合并动画、耗散热光环 | 每帧绘制（≤15 个球） |

| 操作 | 复杂度 | 量级 |
|---|---|---|
| 迷宫生成 | O(N) | 252 |
| 指针投影 | O(S) | 251，每次 mousemove |
| 树上寻路 | O(4N) | 1008，目标变化时 |
| 合并检测 | O(n) | 15，每帧 |
| 渲染 | O(N + n) | 约 500 墙矩形 + 251 线 + 15 球 |

---

## 13. 快捷键

`N` 新游戏 · `R` 重置 · `W` 做功 · `P`/空格 暂停

调试接口：`window.debug.state() / blocks() / physics() / maze() / corridor() / verify() / reset() / newGame()`

---

**文档版本**: v2
**对应代码**: `js/*.js`
