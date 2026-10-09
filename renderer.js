// Render worker: owns the OffscreenCanvas, the PIXI scene and the viewport (pan / zoom).
// Reads market data from the data worker's buffers and never writes to them.
//
// Main thread -> INIT { canvas, port, params }, POINTER { type, x, pointerId }, WHEEL { deltaY }
// Data worker -> DATA_SHARED / DATA_SLICE (see data-worker.js)
// -> Data worker VIEWPORT { rightOffset, visibleCount }

// importScripts('../lib/pixi-worker-lib.js'); // Import Web Worker support PIXI library
import * as PIXI from './pixi-worker.min.mjs';
// import * as PIXI from '/assets/addons/chart-module/pixi-worker.min.mjs';
import PlotInfo from './plot-info.js';
import OHLCVStore, { Field, STRIDE } from './ohlcv-store.js';

const PADDING = 30;
const MIN_BAR_SPACING = 2;
const MAX_BAR_SPACING = 40;
const ZOOM_STEP = 1.1;
const UP_COLOR = 0x00C853;
const DOWN_COLOR = 0xFF5252;
const SMA_COLOR = 0xffd54f;

let app;
let baseChart;
let dataPort;
let candleGraphics;
let smaGraphics;
let infoText;

// The data to draw from.
// Shared memory: the whole dataset, startIndex 0, the bar count is read live from the store.
// Fallback: a copied slice that starts at bar startIndex, with totalCount sent alongside it.
let source;
let drawnVersion = -1;
let needsRedraw = false;

// rightOffset: how many bars the view is scrolled back from the latest bar (0 = follow live data)
const viewport = { rightOffset: 0, barSpacing: 6 };
const drag = { pointerId: undefined, startX: 0, startOffset: 0 };
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

        default:
            console.warn('Render worker: unknown message', msgType);
    }
});

function init({ canvas, port, params }) {
    dataPort = port;
    dataPort.onmessage = onDataMessage;

    app = new PIXI.Application({
        width: params.width,
        height: params.height,
        view: canvas,
        antialias: true,
        resolution: params.resolution,
        preserveDrawingBuffer: true,
        // autoDensity: true, // Cannot be used with Workers
        backgroundColor: params.backgroundColor,
        backgroundAlpha: params.backgroundAlpha
    });

    const textStyle = new PIXI.TextStyle({
        fontFamily: 'Cairo, sans-serif',
        fontSize: 14,
        fill: '#11224E',
        fontStyle: 'normal',
        fontWeight: 'bold',
        strokeThickness: 0
    });

    infoText = new PIXI.Text('Waiting for data...', textStyle);
    infoText.position.set(8, 8);

    candleGraphics = new PIXI.Graphics();
    smaGraphics = new PIXI.Graphics();

    app.stage.addChild(candleGraphics);
    app.stage.addChild(smaGraphics);
    app.stage.addChild(infoText);

    app.ticker.add(onTick);
    sendViewport();

    // setupStockGraph(app);
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
            source = {
                store: OHLCVStore.from(data.ohlcvBuffer),
                indicators: wrapIndicators(data.indicatorBuffers),
                startIndex: data.startIndex,
                totalCount: data.totalCount
            };
            needsRedraw = true;
            break;

        default:
            console.warn('Render worker: unknown data message', msgType);
    }
}

function wrapIndicators(buffers) {
    return Object.fromEntries(Object.entries(buffers).map(([name, buffer]) => [name, new Float64Array(buffer)]));
}

// ---- Frame loop ----

// Runs every animation frame and redraws only when the data or the viewport changed
function onTick() {
    if (!source) {
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

function drawFrame({ total, from, firstIndex, rows, sma }) {
    const barCount = rows.length / STRIDE;

    candleGraphics.clear();
    smaGraphics.clear();

    if (barCount === 0) {
        infoText.text = 'Waiting for data...';
        return;
    }

    const height = app.screen.height;
    const spacing = viewport.barSpacing;
    const bodyWidth = Math.max(1, spacing * 0.7);
    const field = (k, f) => rows[k * STRIDE + f];
    const toX = (k) => PADDING + (firstIndex + k - from) * spacing;

    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (let k = 0; k < barCount; k++) {
        minPrice = Math.min(minPrice, field(k, Field.LOW));
        maxPrice = Math.max(maxPrice, field(k, Field.HIGH));
    }

    const priceRange = maxPrice - minPrice || 1;
    const toY = (price) => PADDING + (maxPrice - price) / priceRange * (height - PADDING * 2);

    for (let k = 0; k < barCount; k++) {
        const open = field(k, Field.OPEN);
        const close = field(k, Field.CLOSE);
        const color = close >= open ? UP_COLOR : DOWN_COLOR;
        const x = toX(k);

        // Wick
        candleGraphics.lineStyle(1, color);
        candleGraphics.moveTo(x + bodyWidth / 2, toY(field(k, Field.HIGH)));
        candleGraphics.lineTo(x + bodyWidth / 2, toY(field(k, Field.LOW)));

        // Body
        candleGraphics.lineStyle(0);
        candleGraphics.beginFill(color);
        candleGraphics.drawRect(x, toY(Math.max(open, close)), bodyWidth, Math.max(1, Math.abs(toY(open) - toY(close))));
        candleGraphics.endFill();
    }

    // SMA line, broken where there is not enough history (NaN)
    smaGraphics.lineStyle(1.5, SMA_COLOR);

    let penDown = false;

    for (let k = 0; k < barCount; k++) {
        if (Number.isNaN(sma[k])) {
            penDown = false;
            continue;
        }

        const x = toX(k) + bodyWidth / 2;
        const y = toY(sma[k]);

        if (penDown) {
            smaGraphics.lineTo(x, y);
        } else {
            smaGraphics.moveTo(x, y);
            penDown = true;
        }
    }

    const last = barCount - 1;
    const lastSma = sma[last];

    infoText.text = `Bars: ${total} (shared: ${source.store.isShared})  ` +
        `O ${field(last, Field.OPEN).toFixed(2)}  H ${field(last, Field.HIGH).toFixed(2)}  ` +
        `L ${field(last, Field.LOW).toFixed(2)}  C ${field(last, Field.CLOSE).toFixed(2)}  ` +
        `V ${field(last, Field.VOLUME)}  SMA ${Number.isNaN(lastSma) ? '-' : lastSma.toFixed(2)}`;
}

// ---- Viewport ----

function onPointer({ type, x, pointerId }) {
    switch (type) {
        case 'down':
            drag.pointerId = pointerId;
            drag.startX = x;
            drag.startOffset = viewport.rightOffset;
            break;

        case 'move':
            if (pointerId === drag.pointerId) {
                // Dragging right reveals older bars
                viewport.rightOffset = drag.startOffset + (x - drag.startX) / viewport.barSpacing;
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
    return Math.max(1, Math.floor((app.screen.width - PADDING * 2) / viewport.barSpacing));
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