// Counts the ArrayBuffer bytes a thread currently holds, without needing cross-origin isolation.
// A buffer is added when it is created or received, and removed when it is transferred away (untrack)
// or garbage collected (FinalizationRegistry). The count therefore includes garbage that has not been
// collected yet, which is exactly where a memory spike shows up.

export function createLiveBytes() {
    const counter = { bytes: 0, collected: 0 };
    const registry = new FinalizationRegistry((bytes) => {
        counter.bytes -= bytes;
        counter.collected++;
    });

    return {
        counter,

        track(buffer) {
            counter.bytes += buffer.byteLength;
            registry.register(buffer, buffer.byteLength, buffer);
        },

        // Call before transferring: afterwards byteLength is 0 and the memory belongs to the other thread
        untrack(buffer) {
            if (registry.unregister(buffer)) {
                counter.bytes -= buffer.byteLength;
            }
        }
    };
}
