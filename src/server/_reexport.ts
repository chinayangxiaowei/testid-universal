/**
 * Cross-layer re-export bridge.
 *
 * The service depends on registry + locators internals, but importing each from
 * its own deep path bloats service.ts. This thin barrel collects exactly what the
 * server layer needs (storage types, reconcile, diff, locator generation) behind
 * one import, without the server reaching across layers ad hoc.
 */
export * from '../registry/storage';
export * from '../registry/registry';
export * from '../registry/diff';
export * from '../locators';
