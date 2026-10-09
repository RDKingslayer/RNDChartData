// Main thread: DOM, user input and app-level commands only. Market data never passes through here.
//
//   Main ──commands──► Data worker ◄──MessageChannel──► Render worker ◄──input── Main
//                      (store + calculations)            (OffscreenCanvas)

const STORE_CAPACITY = 100000;

function createWorker(path) {
    // Resolved relative to this module rather than the page, so it keeps working when bundled as a library
    const worker = new Worker(new URL(path, import.meta.url), { type: 'module' });

    worker.onerror = (e) => console.error(`${path} error:`, e.message, e);

    return worker;
}

function forwardInput(canvas, renderWorker) {
    const sendPointer = (type) => (e) => {
        if (type === 'down') {
            canvas.setPointerCapture(e.pointerId);
        }

        renderWorker.postMessage({ msgType: 'POINTER', data: { type, x: e.offsetX, y: e.offsetY, pointerId: e.pointerId } });
    };

    canvas.addEventListener('pointerdown', sendPointer('down'));
    canvas.addEventListener('pointermove', sendPointer('move'));
    canvas.addEventListener('pointerup', sendPointer('up'));
    canvas.addEventListener('pointercancel', sendPointer('cancel'));

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault(); // Zoom the chart instead of scrolling the page
        renderWorker.postMessage({ msgType: 'WHEEL', data: { deltaY: e.deltaY, x: e.offsetX } });
    }, { passive: false });
}

function init() {
    const htmlCanvas = document.createElement('canvas');

    htmlCanvas.style.touchAction = 'none'; // Let pointer events drive panning on touch screens
    document.getElementById('chartContainer').appendChild(htmlCanvas);

    const offscreen = htmlCanvas.transferControlToOffscreen();
    const dataWorker = createWorker('./data-worker.js');
    const renderWorker = createWorker('./renderer.js');

    // Direct line between the two workers, so data never goes through the main thread
    const { port1, port2 } = new MessageChannel();

    dataWorker.onmessage = (event) => {
        const { msgType, data } = event.data;

        if (msgType === 'STATUS') {
            console.info('Data worker status:', data);
        }
    };

    renderWorker.postMessage({
        msgType: 'INIT',
        data: {
            canvas: offscreen,
            port: port2,
            params: {
                width: 800,
                height: 600,
                resolution: window.devicePixelRatio,
                backgroundColor: '#1099bb',
                backgroundAlpha: 1
            }
        }
    }, [offscreen, port2]);

    dataWorker.postMessage({ msgType: 'INIT', data: { port: port1, capacity: STORE_CAPACITY } }, [port1]);
    dataWorker.postMessage({ msgType: 'LOAD', data: { symbol: 'DEMO', interval: 60 } });

    forwardInput(htmlCanvas, renderWorker);
}

init();
