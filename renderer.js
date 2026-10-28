// Render worker: owns the OffscreenCanvas, draws it with the native Canvas 2D API and owns the viewport (pan / zoom).
// Never writes to the data worker's shared buffers; in fallback mode it owns its slice and applies deltas to it.
//
// Main thread -> INIT { canvas, port, params }, RESIZE { width, height, resolution },
//                POINTER { type, x, y, pointerId }, WHEEL { deltaY }, RESET_PRICE_SCALE
// Data worker -> DATA_SHARED / DATA_SLICE / DATA_DELTA (see data-worker.js)
// -> Data worker VIEWPORT { rightOffset, visibleCount }, RELEASE { ohlcvBuffer, indicatorBuffers }
//
// There is no scene graph: every frame that needs drawing is painted from scratch in CSS pixels,
// with the context scaled by the device pixel ratio so lines and text stay sharp.

import PlotInfo from './plot-info.js';
import OHLCVStore, { Field, STRIDE } from './ohlcv-store.js';

const PADDING = 30;
const MIN_BAR_SPACING = 2;
const MAX_BAR_SPACING = 40;
const ZOOM_STEP = 1.1;
const UP_COLOR = '#00C853';
const DOWN_COLOR = '#FF5252';
const SMA_COLOR = '#ffd54f';
const Y_AXIS_WIDTH = 70; // Price labels on the right
const X_AXIS_HEIGHT = 24; // Time labels at the bottom
const AXIS_COLOR = '#3a4278';
const GRID_COLOR = '#141c4f';
const AXIS_LABEL_COLOR = '#9aa4d6';
const INFO_COLOR = '#FCF1D0';
const INFO_FONT = 'bold 14px Cairo, sans-serif';
const AXIS_FONT = '11px Cairo, sans-serif';
const LAST_PRICE_FONT = 'bold 11px Cairo, sans-serif';
const MIN_PRICE_LABEL_SPACING = 40; // px between price grid lines, at least
const MIN_TIME_LABEL_SPACING = 90; // px between time grid lines, at least
const TIME_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200,
    86400, 172800, 604800, 2592000, 7776000, 31536000]; // Seconds, 1 minute to 1 year
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let baseChart;
let dataPort;
let canvas;
let ctx;
let background;

// Size in CSS pixels; the canvas's drawing buffer is width x height x resolution
const screen = { width: 1, height: 1, resolution: 1 };

// The data to draw from.
// Shared memory: the whole dataset, startIndex 0, the bar count is read live from the store.
// Fallback: a copied slice that starts at bar startIndex, with totalCount sent alongside it.
let source;
let drawnVersion = -1;
let needsRedraw = true;

// rightOffset: how many bars the view is scrolled back from the latest bar (0 = follow live data)
// priceOffset: how far the auto-scaled prices are dragged down, in px (0 = fitted to the visible bars)
const viewport = { rightOffset: 0, barSpacing: 6, priceOffset: 0 };
const drag = { pointerId: undefined, startX: 0, startY: 0, startOffset: 0, startPriceOffset: 0 };
let lastSentViewport = '';

self.addEventListener('message', (event) => {
    const { msgType, data } = event.data;

    switch (msgType) {
        case 'INIT':
            init(data);
            break;

        case 'POINTER':
            onPointer(data);
            break;

        case 'WHEEL':
            onWheel(data);
            break;

        case 'RESIZE':
            onResize(data);
            break;

        case 'RESET_PRICE_SCALE':
            viewport.priceOffset = 0;
            needsRedraw = true;
            break;

        default:
            console.warn('Render worker: unknown message', msgType);
    }
});

function init({ canvas: offscreen, port, params }) {
    dataPort = port;
    dataPort.onmessage = onDataMessage;

    canvas = offscreen;
    ctx = canvas.getContext('2d', { alpha: params.backgroundAlpha < 1 });
    background = { color: params.backgroundColor, alpha: params.backgroundAlpha };

    setSize(params);
    startFrameLoop();
    sendViewport();

    // setupStockGraph();
}

// Resizing the drawing buffer also clears it, so the next frame always redraws
function setSize({ width, height, resolution }) {
    screen.width = width;
    screen.height = height;
    screen.resolution = resolution;

    canvas.width = Math.max(1, Math.round(width * resolution));
    canvas.height = Math.max(1, Math.round(height * resolution));
    needsRedraw = true;
}

// requestAnimationFrame is available in dedicated workers that own an OffscreenCanvas in current browsers;
// the timer is only a fallback for engines without it
function startFrameLoop() {
    const schedule = self.requestAnimationFrame
        ? (fn) => self.requestAnimationFrame(fn)
        : (fn) => setTimeout(fn, 16);

    const loop = () => {
        onTick();
        schedule(loop);
    };

    schedule(loop);
}

function onDataMessage(event) {
    const { msgType, data } = event.data;

    switch (msgType) {
        case 'DATA_SHARED':
            source = {
                store: OHLCVStore.from(data.ohlcvBuffer),
                indicators: wrapIndicators(data.indicatorBuffers),
                startIndex: 0,
                totalCount: undefined
            };
            needsRedraw = true;
            break;

        case 'DATA_SLICE':
            releaseSlice();
            source = {
                store: OHLCVStore.from(data.ohlcvBuffer),
                indicators: wrapIndicators(data.indicatorBuffers),
                startIndex: data.startIndex,
                totalCount: data.totalCount
            };
            needsRedraw = true;
            break;

        case 'DATA_DELTA':
            applyDelta(data);
            break;

        default:
            console.warn('Render worker: unknown data message', msgType);
    }
}

// Fallback: hands the current slice's buffers back to the data worker for reuse. They are detached here
// afterwards, which is fine because frames are drawn from copies taken in readVisibleBars().
function releaseSlice() {
    if (!source || source.store.isShared) {
        return;
    }

    const ohlcvBuffer = source.store.buffer;
    const indicatorBuffers = Object.fromEntries(Object.entries(source.indicators).map(([name, series]) => [name, series.buffer]));

    dataPort.postMessage({ msgType: 'RELEASE', data: { ohlcvBuffer, indicatorBuffers } }, [ohlcvBuffer, ...Object.values(indicatorBuffers)]);
}

// Fallback live update: rows from startIndex on, already clipped by the data worker to what this slice can hold
function applyDelta({ startIndex, rows, indicatorValues, totalCount }) {
    if (rows.length > 0) {
        const localIndex = startIndex - source.startIndex;

        source.store.setRows(localIndex, rows);

        for (const [name, values] of Object.entries(indicatorValues)) {
            source.indicators[name].set(values, localIndex);
        }
    }

    source.totalCount = totalCount;
    needsRedraw = true;
}

function wrapIndicators(buffers) {
    return Object.fromEntries(Object.entries(buffers).map(([name, buffer]) => [name, new Float64Array(buffer)]));
}

// ---- Frame loop ----

// Runs every animation frame and redraws only when the data or the viewport changed
function onTick() {
    if (!source) {
        if (needsRedraw) {
            drawFrame(undefined);
            needsRedraw = false;
        }

        return;
    }

    const version = source.store.version;

    if (!needsRedraw && version === drawnVersion) {
        return;
    }

    let frame;

    // Copy the visible bars out under the sequence lock, then draw from the copy.
    // If the data worker was mid-write, skip this frame and try again on the next one.
    if (!source.store.tryRead(() => { frame = readVisibleBars(); })) {
        return;
    }

    drawFrame(frame);
    drawnVersion = version;
    needsRedraw = false;
}

function readVisibleBars() {
    const { store, indicators, startIndex } = source;
    const total = getTotalCount();
    const to = Math.max(0, total - Math.round(viewport.rightOffset));
    const from = Math.max(0, to - getVisibleCount());

    // In fallback mode the slice may not cover the whole range yet while a new one is on its way
    const localFrom = clamp(from - startIndex, 0, store.length);
    const localTo = clamp(to - startIndex, 0, store.length);

    return {
        total,
        from,
        firstIndex: startIndex + localFrom,
        rows: store.data.slice(localFrom * STRIDE, localTo * STRIDE),
        sma: indicators.sma.slice(localFrom, localTo)
    };
}

// Paints the whole chart: background, then (clipped to the plot area) grid, candles and SMA, then axes and text
function drawFrame(frame) {
    const area = getPlotArea();
    const barCount = frame ? frame.rows.length / STRIDE : 0;

    // Work in CSS pixels from here on
    ctx.setTransform(screen.resolution, 0, 0, screen.resolution, 0, 0);
    clearBackground();

    if (barCount === 0) {
        drawAxisFrame(area);
        drawInfo('Waiting for data...');
        return;
    }

    const { total, from, firstIndex, rows, sma } = frame;
    const spacing = viewport.barSpacing;
    const bodyWidth = Math.max(1, spacing * 0.7);
    const field = (k, f) => rows[k * STRIDE + f];
    const toX = (k) => area.left + (firstIndex + k - from) * spacing;
    const centerX = (k) => toX(k) + bodyWidth / 2;

    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (let k = 0; k < barCount; k++) {
        minPrice = Math.min(minPrice, field(k, Field.LOW));
        maxPrice = Math.max(maxPrice, field(k, Field.HIGH));
    }

    const priceRange = maxPrice - minPrice || 1;
    const pxPerPrice = (area.bottom - area.top) / priceRange;
    const toY = (price) => area.top + (maxPrice - price) * pxPerPrice + viewport.priceOffset;
    const toPrice = (y) => maxPrice - (y - area.top - viewport.priceOffset) / pxPerPrice;

    const priceTicks = getPriceTicks(area, toY, toPrice(area.bottom), toPrice(0));
    const timeTicks = getTimeTicks(area, barCount, field, centerX);

    // Candles and the SMA are clipped to the plot area, so they never run over the axes while dragging
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, area.right, area.bottom);
    ctx.clip();

    drawGrid(area, priceTicks, timeTicks);
    drawCandles(barCount, field, toX, toY, bodyWidth);
    drawSma(barCount, sma, centerX, toY);

    ctx.restore();

    drawAxisFrame(area);
    drawPriceAxis(area, priceTicks);
    drawTimeAxis(area, timeTicks);

    const last = barCount - 1;
    const lastSma = sma[last];

    drawLastPrice(area, field(last, Field.CLOSE), field(last, Field.OPEN), toY);

    drawInfo(`Bars: ${total} (shared: ${source.store.isShared})  ` +
        `O ${field(last, Field.OPEN).toFixed(2)}  H ${field(last, Field.HIGH).toFixed(2)}  ` +
        `L ${field(last, Field.LOW).toFixed(2)}  C ${field(last, Field.CLOSE).toFixed(2)}  ` +
        `V ${field(last, Field.VOLUME)}  SMA ${Number.isNaN(lastSma) ? '-' : lastSma.toFixed(2)}`);
}

function clearBackground() {
    ctx.clearRect(0, 0, screen.width, screen.height);
    ctx.globalAlpha = background.alpha;
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, screen.width, screen.height);
    ctx.globalAlpha = 1;
}

// One path per colour for wicks and one for bodies, so the whole series costs four draw calls
function drawCandles(barCount, field, toX, toY, bodyWidth) {
    const paths = {
        up: { wicks: new Path2D(), bodies: new Path2D() },
        down: { wicks: new Path2D(), bodies: new Path2D() }
    };

    for (let k = 0; k < barCount; k++) {
        const open = field(k, Field.OPEN);
        const close = field(k, Field.CLOSE);
        const { wicks, bodies } = close >= open ? paths.up : paths.down;
        const x = toX(k);
        const wickX = Math.round(x + bodyWidth / 2) + 0.5;
        const bodyTop = toY(Math.max(open, close));

        wicks.moveTo(wickX, toY(field(k, Field.HIGH)));
        wicks.lineTo(wickX, toY(field(k, Field.LOW)));
        bodies.rect(x, bodyTop, bodyWidth, Math.max(1, toY(Math.min(open, close)) - bodyTop));
    }

    ctx.lineWidth = 1;

    for (const [color, { wicks, bodies }] of [[UP_COLOR, paths.up], [DOWN_COLOR, paths.down]]) {
        ctx.strokeStyle = color;
        ctx.stroke(wicks);
        ctx.fillStyle = color;
        ctx.fill(bodies);
    }
}

// SMA line, broken where there is not enough history (NaN)
function drawSma(barCount, sma, centerX, toY) {
    let penDown = false;

    ctx.beginPath();

    for (let k = 0; k < barCount; k++) {
        if (Number.isNaN(sma[k])) {
            penDown = false;
            continue;
        }

        if (penDown) {
            ctx.lineTo(centerX(k), toY(sma[k]));
        } else {
            ctx.moveTo(centerX(k), toY(sma[k]));
            penDown = true;
        }
    }

    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = SMA_COLOR;
    ctx.stroke();
}

function drawInfo(text) {
    ctx.font = INFO_FONT;
    ctx.fillStyle = INFO_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, 8, 8);
}

// ---- Axes ----

// Prices are scaled into [top, bottom]; the clip region is everything left of the price axis and above the time axis
function getPlotArea() {
    const { width, height } = screen;
    const right = Math.max(PADDING + 1, width - Y_AXIS_WIDTH);
    const bottom = Math.max(PADDING + 1, height - X_AXIS_HEIGHT);

    return { left: PADDING, top: PADDING, right, bottom, width, height };
}

function drawAxisFrame({ right, bottom, width, height }) {
    ctx.beginPath();
    ctx.moveTo(right + 0.5, 0);
    ctx.lineTo(right + 0.5, height);
    ctx.moveTo(0, bottom + 0.5);
    ctx.lineTo(width, bottom + 0.5);
    ctx.lineWidth = 1;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.stroke();
}

function drawGrid(area, priceTicks, timeTicks) {
    ctx.beginPath();

    for (const { y } of priceTicks) {
        ctx.moveTo(0, y);
        ctx.lineTo(area.right, y);
    }

    for (const { x } of timeTicks) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, area.bottom);
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.stroke();
}

// Round prices (1, 2 or 5 x 10^n apart) across the visible price range, as { y, label }
function getPriceTicks(area, toY, lowPrice, highPrice) {
    const maxTicks = Math.max(1, Math.floor(area.bottom / MIN_PRICE_LABEL_SPACING));
    const step = niceStep(highPrice - lowPrice, maxTicks);
    const decimals = clamp(-Math.floor(Math.log10(step)), 0, 8);
    const ticks = [];

    for (let i = Math.ceil(lowPrice / step); i * step <= highPrice; i++) {
        const price = i * step;
        const y = Math.round(toY(price)) + 0.5;

        // Keep labels clear of the time axis and the top edge
        if (y >= 6 && y <= area.bottom - 6) {
            ticks.push({ y, label: price.toFixed(decimals) });
        }
    }

    return ticks;
}

// The first bar of each time step, as { x, label }. The step is the smallest round duration that keeps
// labels MIN_TIME_LABEL_SPACING apart at the current zoom.
function getTimeTicks(area, barCount, field, centerX) {
    const interval = barCount > 1 ? field(1, Field.TIME) - field(0, Field.TIME) : 60;
    const minStep = interval * Math.ceil(MIN_TIME_LABEL_SPACING / viewport.barSpacing);
    const step = TIME_STEPS.find((s) => s >= minStep) ?? TIME_STEPS[TIME_STEPS.length - 1];
    const ticks = [];
    let lastX = -Infinity;
    let previous = localTime(field(0, Field.TIME));

    for (let k = 1; k < barCount; k++) {
        const time = localTime(field(k, Field.TIME));

        if (Math.floor(time / step) !== Math.floor(previous / step)) {
            const x = Math.round(centerX(k)) + 0.5;
            const newDay = Math.floor(time / 86400) !== Math.floor(previous / 86400);

            // Gaps in the data can put two step boundaries close together; keep the labels apart anyway
            if (x - lastX >= MIN_TIME_LABEL_SPACING * 0.6 && x < area.right - 20) {
                ticks.push({ x, label: formatTime(time, step, newDay) });
                lastX = x;
            }
        }

        previous = time;
    }

    return ticks;
}

function drawPriceAxis(area, ticks) {
    ctx.beginPath();

    for (const { y } of ticks) {
        ctx.moveTo(area.right, y);
        ctx.lineTo(area.right + 4, y);
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.stroke();

    ctx.font = AXIS_FONT;
    ctx.fillStyle = AXIS_LABEL_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const { y, label } of ticks) {
        ctx.fillText(label, area.right + 8, y);
    }
}

function drawTimeAxis(area, ticks) {
    ctx.beginPath();

    for (const { x } of ticks) {
        ctx.moveTo(x, area.bottom);
        ctx.lineTo(x, area.bottom + 4);
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.stroke();

    ctx.font = AXIS_FONT;
    ctx.fillStyle = AXIS_LABEL_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const { x, label } of ticks) {
        ctx.fillText(label, x, area.bottom + X_AXIS_HEIGHT / 2);
    }
}

// Marks the latest close with a line across the plot and a tag on the price axis, coloured like its candle
function drawLastPrice(area, close, open, toY) {
    const y = Math.round(toY(close)) + 0.5;

    if (y < 0 || y > area.bottom) {
        return;
    }

    const color = close >= open ? UP_COLOR : DOWN_COLOR;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(area.right, y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.fillRect(area.right + 1, y - 9, Y_AXIS_WIDTH - 1, 18);

    ctx.font = LAST_PRICE_FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(close.toFixed(2), area.right + 8, y);
}

// 1, 2 or 5 x 10^n, the smallest that keeps range / step at or under maxTicks
function niceStep(range, maxTicks) {
    const raw = (range || 1) / maxTicks;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;

    return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

// Unix seconds shifted to the local time zone, so day steps break at local midnight
function localTime(time) {
    return time - new Date(time * 1000).getTimezoneOffset() * 60;
}

function formatTime(time, step, newDay) {
    const date = new Date(time * 1000); // Already shifted to local time, so read it back as UTC

    if (step >= 2592000) {
        return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    }

    if (step >= 86400 || newDay) {
        return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
    }

    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

// ---- Viewport ----

function onPointer({ type, x, y, pointerId }) {
    switch (type) {
        case 'down':
            drag.pointerId = pointerId;
            drag.startX = x;
            drag.startY = y;
            drag.startOffset = viewport.rightOffset;
            drag.startPriceOffset = viewport.priceOffset;
            break;

        case 'move':
            if (pointerId === drag.pointerId) {
                // Dragging right reveals older bars; dragging up or down moves the prices with the pointer
                viewport.rightOffset = drag.startOffset + (x - drag.startX) / viewport.barSpacing;
                viewport.priceOffset = drag.startPriceOffset + (y - drag.startY);
                onViewportChanged();
            }
            break;

        case 'up':
        case 'cancel':
            if (pointerId === drag.pointerId) {
                drag.pointerId = undefined;
            }
            break;
    }
}

function onWheel({ deltaY }) {
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;

    viewport.barSpacing = clamp(viewport.barSpacing * factor, MIN_BAR_SPACING, MAX_BAR_SPACING);
    onViewportChanged();
}

// The container changed size (or devicePixelRatio changed). The canvas's drawing buffer becomes
// width x height x resolution; the canvas element's CSS size is handled by the page.
// More or fewer bars now fit, so the data worker gets a new visibleCount through onViewportChanged().
function onResize(size) {
    setSize(size);
    onViewportChanged();
}

function onViewportChanged() {
    const maxOffset = source ? Math.max(0, getTotalCount() - 1) : 0;

    viewport.rightOffset = clamp(viewport.rightOffset, 0, maxOffset);
    needsRedraw = true;
    sendViewport();
}

// Tells the data worker what is on screen, only when the whole-bar values actually change
function sendViewport() {
    const data = { rightOffset: Math.round(viewport.rightOffset), visibleCount: getVisibleCount() };
    const key = `${data.rightOffset}:${data.visibleCount}`;

    if (key !== lastSentViewport) {
        lastSentViewport = key;
        dataPort.postMessage({ msgType: 'VIEWPORT', data });
    }
}

function getTotalCount() {
    return source.totalCount ?? source.store.length;
}

function getVisibleCount() {
    const { left, right } = getPlotArea();

    return Math.max(1, Math.floor((right - left) / viewport.barSpacing));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function setupStockGraph () {
    let params= {};
    let dataArray = [
        [
            1760857200,
            27.52,
            27.62,
            27.52,
            27.6,
            47838,
            1316517.99,
            39,
            27.52,
            1104.4,
            40,
            2,
            1315413.625,
            47798,
            37,
            0,
            0,
            40,
            47798,
            7.82,
            1.28,
            0,
            0,
            0,
            0,
            -0.08,
            -0.29,
            0,
            0,
            0
        ],
        [
            1760857260,
            27.64,
            27.68,
            27.64,
            27.66,
            5071,
            140163.88,
            4,
            27.53,
            138780.875,
            5021,
            3,
            1383,
            50,
            1,
            0,
            0,
            5021,
            50,
            7.82,
            1.28,
            0,
            0,
            0,
            0,
            -0.02,
            -0.07,
            0,
            0,
            0
        ],
        [
            1760857380,
            27.68,
            27.68,
            27.68,
            27.68,
            40,
            1107.2,
            1,
            27.53,
            1107.2,
            40,
            1,
            0,
            0,
            0,
            0,
            0,
            40,
            0,
            7.82,
            1.28,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
        ],
        [
            1760857440,
            27.68,
            27.68,
            27.68,
            27.68,
            160,
            4428.8,
            2,
            27.53,
            4428.8,
            160,
            2,
            0,
            0,
            0,
            0,
            0,
            160,
            0,
            7.82,
            1.28,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
        ],
        [
            1760857500,
            27.68,
            27.68,
            27.68,
            27.68,
            7365,
            203863.2,
            8,
            27.55,
            203863.203,
            7365,
            8,
            0,
            0,
            0,
            0,
            0,
            7365,
            0,
            7.82,
            1.28,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
        ],
    ];

    console.error('***setupStockGraph ', new PlotInfo());
    // params.langObj = languageDataStore.getLanguageObj();
    // params.chartDataProvider = this.get('chartDataProvider');
    // params.isStopRendering = !(this.utils.nativeHelper.isNativePlatformSupported ? this.utils.nativeHelper.getEmberAppGlobal().events.isAppShown : true);
    // params.dpi = this.$('#dpi')[0];
    // params.isEnablePixiInstanceLifeCycleDebug = appConfig.chartConfig.isEnablePixiInstanceLifeCycleDebug;
    // params.isTradingEnabled = this.isTradingEnabled && !sharedService.getService('trade').isDt;
    // params.isNotAnEmbeddedChart = this.isNotAnEmbeddedChart;
    // params.proChartWkey = this.wkey;
    // params.chartBGColor = sharedService.userSettings.currentTheme === ChartCoreConstants.ThemeType.Light ? that.get('chartLightBGColor') : that.get('chartDarkBGColor');
    // params.bgColorAlpha = params.chartBGColor.length === 9 ? (parseInt(params.chartBGColor.slice(-2), 16) / 255) : 0.4; // To set a default opacity for hex colors without alpha (6 digits)
    // params.chartAlertCallBackFunc = this.onCreateChartAlerts.bind(this);
    // params.isTradeOnChartLimitOrdersVisible = this.isTradeOnChartLimitOrdersVisible;
    // params.isTradeOnChartStopMarketOrderVisible = this.isTradeOnChartStopMarketOrderVisible;
    //
    // this.initIndicatorTooltipOptions();
    // params.indicatorTooltipOption = this.indicatorTooltipOption;
    //
    // baseChart = new StockGraph()
}