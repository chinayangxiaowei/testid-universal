/**
 * Library entry point.
 *
 * Re-exports the public surface so consumers can:
 *   import { LocalTransport, HttpTransport, runPipeline, HtmlTemplateAdapter,
 *            JsonFileStorage, InMemoryStorage, diff, generateLocators } from 'testid-universal';
 */
export * from './core';
export * from './registry';
export * from './locators';
export * from './testmap';
export * from './runtime';
export * from './runtime/playwright';
export * from './adapters';
export * from './server/service';
export * from './client/transport';
export * from './client/pipeline';
