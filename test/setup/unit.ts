/**
 * Unit Test Setup
 */

// Global test configuration
process.env['NODE_ENV'] = 'test';
process.env['PI_RESEARCH_DEBUG'] = 'false';
process.env['PI_RESEARCH_FORCE_READY'] = 'true';

// Increase EventEmitter max listeners to avoid warnings during tests.
// The pi-research extension registers signal handlers (SIGINT, SIGTERM, SIGHUP)
// which can cause warnings when tests load the extension multiple times.
process.setMaxListeners(20);
