const { ThreadWorker } = require('poolifier');

/**
 * Minimal worker for Poolifier.
 * Since browser handles are non-serializable, we use the pool
 * primarily for concurrency management in the main thread,
 * but Poolifier still requires a valid worker script.
 */
module.exports = new ThreadWorker(() => {
    return { ok: true };
}, {
    maxInactiveTime: 60000
});
