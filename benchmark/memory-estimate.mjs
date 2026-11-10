// Memory estimate for the two data delivery options. Run with: node memory-estimate.mjs [charts]
// (default 1 chart; several charts share the screen in a square grid, e.g. 16 = 4 x 4)
//
// Option 1: the renderer holds a full copy of every row.
// Option 2: the renderer holds a window of 3x the visible bars (2x behind, 1x ahead) plus headroom,
//           sized up by 25% for reuse, and up to 4 window buffers stay allocated (1 in use, 3 kept for reuse).
// Both: the data worker's own store of every row is the same, so it is only added in the totals.

const ROWS = 30000;
const CHARTS = Number(process.argv[2] ?? 1);
const GRID_COLUMNS = Math.ceil(Math.sqrt(CHARTS));
const INDICATORS = 1;
const BYTES_PER_ROW = 6 * 8 + INDICATORS * 8; // time, open, high, low, close, volume + indicators, Float64 each

// Window sizing for option 2
const WINDOW_SPANS = 3;
const HEADROOM_ROWS = 64;
const GROWTH = 1.25;
const BUFFERS_KEPT = 4;

// Plot width = screen width minus 30 px left padding and a 70 px price axis
const PLOT_MARGIN_PX = 100;

const MB = (bytes) => (bytes / 1e6).toFixed(2);

function visibleBars(screenWidth, barSpacing) {
    return Math.max(1, Math.floor((screenWidth / GRID_COLUMNS - PLOT_MARGIN_PX) / barSpacing));
}

function option2Bytes(visible) {
    const rows = Math.ceil((visible * WINDOW_SPANS + HEADROOM_ROWS) * GROWTH);
    return rows * BYTES_PER_ROW * BUFFERS_KEPT * CHARTS;
}

const option1 = ROWS * BYTES_PER_ROW * CHARTS;
const store = ROWS * BYTES_PER_ROW * CHARTS;

const cases = [
    ['1080p, default 6 px bars', 1920, 6],
    ['4K, default 6 px bars', 3840, 6],
    ['1080p, fully zoomed out at 2 px', 1920, 2],
    ['4K, fully zoomed out at 2 px', 3840, 2]
];

console.log(`${CHARTS} chart(s) in a ${GRID_COLUMNS}-column grid, ${ROWS.toLocaleString()} rows each, ${INDICATORS} indicator(s), ${BYTES_PER_ROW} bytes per row`);
console.log('Memory figures are for all charts together; visible bars are per chart\n');
console.log('Screen and zoom'.padEnd(34) + 'Visible  Option 1 MB  Option 2 MB  Saving MB  Total opt 1 / opt 2 MB');

for (const [name, width, spacing] of cases) {
    const visible = visibleBars(width, spacing);
    const option2 = option2Bytes(visible);

    console.log(
        name.padEnd(34) +
        String(visible).padStart(7) +
        MB(option1).padStart(12) +
        MB(option2).padStart(13) +
        MB(option1 - option2).padStart(11) +
        `   ${MB(store + option1)} / ${MB(store + option2)}`
    );
}

// Option 2 with double buffering (2 window buffers) as zoom-out shows more bars.
// A window never holds more rows than the dataset, so once it covers everything,
// two buffers hold two full copies.
const DOUBLE_BUFFERS = 2;
const windowRows = (visible) => Math.min(ROWS, Math.ceil((visible * WINDOW_SPANS + HEADROOM_ROWS) * GROWTH));
const doubleBuffered = (visible) => windowRows(visible) * BYTES_PER_ROW * DOUBLE_BUFFERS * CHARTS;

let crossover = 1;
while (doubleBuffered(crossover) <= option1) {
    crossover++;
}

console.log(`\nOption 2 double-buffered, by visible bars (uses more than option 1 from ${crossover.toLocaleString()} visible bars)`);
console.log('Visible bars'.padEnd(14) + 'Window rows  Option 1 MB  Option 2 MB  Total opt 1 / opt 2 MB');

for (const visible of [visibleBars(1920, 2), visibleBars(3840, 2), crossover, 10000, ROWS]) {
    const option2 = doubleBuffered(visible);

    console.log(
        visible.toLocaleString().padEnd(14) +
        windowRows(visible).toLocaleString().padStart(11) +
        MB(option1).padStart(12) +
        MB(option2).padStart(13) +
        `   ${MB(store + option1)} / ${MB(store + option2)}`
    );
}

// Option 1's extra memory as rows, indicators and charts grow
console.log('\nOption 1 extra memory = rows x (48 + 8 x indicators) x charts');

for (const [rows, indicators, charts] of [[30000, 1, 1], [30000, 10, 1], [30000, 10, 8], [1000000, 5, 1]]) {
    const bytes = rows * (48 + 8 * indicators) * charts;
    console.log(`  ${rows.toLocaleString().padStart(9)} rows, ${String(indicators).padStart(2)} indicators, ${charts} chart(s): ${MB(bytes)} MB`);
}
