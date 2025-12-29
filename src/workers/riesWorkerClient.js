// src/workers/riesWorkerClient.js
console.log("✅✅✅ USING UPDATED riesWorkerClient.js FILE");

// ======================
// Defaults: "Your solver"
// ======================
const DEFAULT_RIES_OPTIONS = {
  // Use x at most once per side
  onlyOneSymbols: "x",

  // IMPORTANT: exp is lowercase 'e' in this RIES build
  // Allowed building blocks:
  // x (variable), p (pi), q (sqrt), e (exp), n (negate),
  // + - * / ^, and digits 1 2 3 5 7
  onlyUseSymbols: "xpqen+-*/^12357",
};

// Constants
const MAX_HEARTBEAT_SILENCE = 30000; // 30 seconds (much safer)
const MEMORY_READINGS_MAX = 5;
const MEMORY_GROWTH_THRESHOLD = 20;
const HEARTBEAT_CHECK_INTERVAL = 1000;
const RETRY_DELAY = 100;
const CRITICAL_RETRY_DELAY = 500;

// Memory error patterns to detect in global errors
const MEMORY_ERROR_PATTERNS = [
  "memory access out of bounds",
  "out of memory",
  "heap",
  "allocation",
];

// Singleton worker instance
let worker = null;
const callbacks = new Map();
let msgId = 0;
let lastHeartbeatTime = 0;
let heartbeatWatchdog = null;
let memoryReadings = [];

/**
 * Remove empty-string options that would accidentally override defaults.
 */
function normalizeOptions(options = {}) {
  const cleaned = { ...(options || {}) };

  for (const k of ["onlyUseSymbols", "onlyOneSymbols", "neverUseSymbols", "solutionType"]) {
    if (typeof cleaned[k] === "string" && cleaned[k].trim() === "") {
      delete cleaned[k];
    }
  }

  return cleaned;
}

/**
 * Build the RIES command arguments from options.
 */
function buildArgs(options = {}) {
  const args = [];

  if (options.neverUseSymbols) args.push(`-N${options.neverUseSymbols}`);
  if (options.onlyOneSymbols) args.push(`-O${options.onlyOneSymbols}`);
  if (options.onlyUseSymbols) args.push(`-S${options.onlyUseSymbols}`);
  if (options.solutionType) args.push(`-${options.solutionType}`);
  if (options.solveForX) args.push("-s");

  if (Array.isArray(options.extraArgs)) {
    for (const a of options.extraArgs) {
      if (typeof a === "string" && a.trim() !== "") args.push(a);
    }
  }

  if (!args.some((arg) => arg.startsWith("-F"))) args.push("-F3");
  return args;
}

/**
 * Log memory statistics if available
 */
function logMemoryStats(label) {
  if (window.performance && window.performance.memory) {
    const memUsed = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
    const memTotal = Math.round(window.performance.memory.totalJSHeapSize / (1024 * 1024));
    const memLimit = Math.round(window.performance.memory.jsHeapSizeLimit / (1024 * 1024));
    const usagePercent = Math.round((memUsed / memTotal) * 100);

    console.debug(`📊 Memory ${label}: ${memUsed}MB/${memTotal}MB/${memLimit}MB (${usagePercent}% usage)`);
    return { used: memUsed, total: memTotal, limit: memLimit, percent: usagePercent };
  }
  return null;
}

/**
 * Reset and recreate the worker
 */
function resetWorker() {
  console.warn("🔄 Resetting RIES worker due to potential memory issues");
  logMemoryStats("before reset");

  if (worker) {
    try {
      worker.terminate();
    } catch (e) {
      console.error("❌ Failed to terminate worker:", e);
    }
    worker = null;
  }

  worker = new Worker(new URL("./ries.worker.js", import.meta.url));
  setupWorkerHandlers();

  // Restart watchdog after reset
  startHeartbeatWatchdog();
  console.debug("✅ New worker created and handlers set up");
}

/**
 * Retry a calculation request
 */
function retryRequest(id, cb, delay = RETRY_DELAY, isCritical = false) {
  if (!cb.hasRetried) {
    console.log(`🔄 ${isCritical ? "Critical recovery" : "Retrying"} for request ${id}`);
    callbacks.set(id, { ...cb, hasRetried: true });

    setTimeout(() => {
      const args = buildArgs(cb.options || {});
      worker.postMessage({ id, targetValue: cb.targetValue, args, retry: true });
    }, delay);
  } else {
    console.warn(`❌ Already retried request ${id}, giving up`);
    const errorMsg = isCritical
      ? "Critical memory error occurred after retry"
      : "Calculation failed after retry, likely due to memory limitations";
    cb.reject(new Error(errorMsg));
    callbacks.delete(id);
  }
}

function processPendingCallbacks(pendingCallbacks, isCritical = false) {
  pendingCallbacks.forEach((cb, id) => {
    retryRequest(id, cb, isCritical ? CRITICAL_RETRY_DELAY : RETRY_DELAY, isCritical);
  });
}

/**
 * Set up worker handlers
 */
function setupWorkerHandlers() {
  worker.onmessage = (event) => {
    const { id, result, error, memoryError, type, timestamp } = event.data;

    if (type === "heartbeat") {
      lastHeartbeatTime = timestamp;
      return;
    }

    const cb = callbacks.get(id);
    if (!cb) return;

    if (memoryError) {
      console.log("📉 RIES memory error, restarting worker and retrying...");
      resetWorker();
      retryRequest(id, cb);
    } else if (error) {
      cb.reject(new Error(error));
      callbacks.delete(id);
    } else {
      cb.resolve(result);
      callbacks.delete(id);
    }
  };

  worker.onerror = (err) => {
    console.error("🔥 Worker error detected:", err);
    const pendingCallbacks = new Map(callbacks);
    resetWorker();
    processPendingCallbacks(pendingCallbacks);
  };

  if (window.addEventListener) {
    window.addEventListener(
      "error",
      function (event) {
        if (
          event &&
          event.message &&
          MEMORY_ERROR_PATTERNS.some((pattern) => event.message.includes(pattern)) &&
          event.filename &&
          event.filename.includes("riesWorkerClient.js")
        ) {
          console.error(`🚨 Critical memory error detected: ${event.message}`);
          const pendingCallbacks = new Map(callbacks);
          resetWorker();
          processPendingCallbacks(pendingCallbacks, true);
          return true;
        }
        return false;
      },
      true
    );
  }
}

/**
 * Track memory usage trend (optional)
 */
function trackMemoryUsage() {
  if (!(window.performance && window.performance.memory)) return false;

  const currentMemory = {
    timestamp: Date.now(),
    used: window.performance.memory.usedJSHeapSize,
    total: window.performance.memory.totalJSHeapSize,
    limit: window.performance.memory.jsHeapSizeLimit,
  };

  memoryReadings.push(currentMemory);
  if (memoryReadings.length > MEMORY_READINGS_MAX) memoryReadings.shift();
  if (memoryReadings.length < 2) return false;

  const oldest = memoryReadings[0];
  const newest = memoryReadings[memoryReadings.length - 1];

  const growthPercent = ((newest.used - oldest.used) / oldest.used) * 100;
  const usagePercent = (newest.used / newest.total) * 100;

  if (growthPercent > MEMORY_GROWTH_THRESHOLD && usagePercent > 70) return true;
  if ((newest.used / newest.limit) * 100 > 80) return true;

  return false;
}

/**
 * Start watching for heartbeats from the worker.
 * FIX: only treat missing heartbeats as a problem when there are pending requests.
 */
function startHeartbeatWatchdog() {
  console.debug("🐕 Starting heartbeat watchdog");
  console.log("✅ MAX_HEARTBEAT_SILENCE =", MAX_HEARTBEAT_SILENCE);

  if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);

  lastHeartbeatTime = Date.now();
  memoryReadings = [];

  heartbeatWatchdog = setInterval(() => {
    // ✅ If we have no pending requests, the worker can be quiet.
    if (callbacks.size === 0) {
      lastHeartbeatTime = Date.now();
      return;
    }

    const timeSince = Date.now() - lastHeartbeatTime;
    const memoryConcern = trackMemoryUsage();

    if (timeSince > MAX_HEARTBEAT_SILENCE || memoryConcern) {
      console.warn(
        timeSince > MAX_HEARTBEAT_SILENCE
          ? `⚠️ No heartbeat for ${timeSince}ms during an active request, resetting...`
          : `⚠️ Resetting worker due to concerning memory usage pattern`
      );

      const pendingCallbacks = new Map(callbacks);
      resetWorker();
      processPendingCallbacks(pendingCallbacks);
    }
  }, HEARTBEAT_CHECK_INTERVAL);
}

/**
 * Initialize the worker once and reuse it
 */
function initWorker() {
  if (worker) return;

  worker = new Worker(new URL("./ries.worker.js", import.meta.url));
  setupWorkerHandlers();
  startHeartbeatWatchdog();
}

export function restartRiesModule() {
  initWorker();

  return new Promise((resolve, reject) => {
    const id = msgId++;
    callbacks.set(id, { resolve, reject });
    worker.postMessage({ id, command: "restart" });
  });
}

/**
 * Send a calculation request to the worker
 */
export function sendRiesRequest(targetValue, options = {}) {
  initWorker();

  const mergedOptions = { ...DEFAULT_RIES_OPTIONS, ...normalizeOptions(options) };
  const args = buildArgs(mergedOptions);

  console.log("✅ mergedOptions:", mergedOptions);
  console.log("✅ RIES args being sent:", args);

  return new Promise((resolve, reject) => {
    const id = msgId++;
    callbacks.set(id, {
      resolve,
      reject,
      targetValue,
      hasRetried: false,
      options: mergedOptions,
    });

    worker.postMessage({ id, targetValue, args });
  });
}
