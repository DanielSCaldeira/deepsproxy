import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(
  readFileSync(new URL('../.zed/settings.json', import.meta.url), 'utf8'),
);
const availableModels = settings.language_models.openai_compatible['deepsproxy-local'].available_models;

test('Zed models expose a 64k context window for Flash and Thinking', () => {
  for (const modelId of ['deepseek-v4-flash', 'deepseek-v4-flash-thinking']) {
    const model = availableModels.find((entry: { name: string }) => entry.name === modelId);
    assert.ok(model, `Expected ${modelId} to be configured in Zed`);
    assert.equal(model.max_tokens, 64_000);
  }
});
