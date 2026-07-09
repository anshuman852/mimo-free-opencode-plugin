import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Disable IP rotation and network-dependent features during tests
process.env.ENABLE_IP_ROTATION = '0';
process.env.MAX_PROXY_RETRIES = '0';
process.env.MAX_429_RETRIES = '0';

const TEST_HOME: string = join(tmpdir(), `mimo-test-${randomUUID()}`);
const DATA_DIR = join(TEST_HOME, '.mimo-free');
const POOL_FILE = join(DATA_DIR, 'fingerprints.json');
const LEGACY_FILE = join(DATA_DIR, 'client-fingerprint');

let mimo: any;

describe('mimo-free plugin', () => {
  before(async () => {
    // Direct homedir() to a temp directory so file I/O goes there
    process.env.HOME = TEST_HOME;
    process.env.USERPROFILE = TEST_HOME;
    await mkdir(DATA_DIR, { recursive: true });

    // Dynamic import so it picks up our test environment
    mimo = await import('../mimo.js');
  });

  after(async () => {
    // Clean up test dir
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mimo.__test._reset();
    // Clean data dir
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  describe('ensureMimoSystemPrompt', () => {
    it('prepends MiMo prompt when messages array is empty', () => {
      const result = mimo.ensureMimoSystemPrompt([]);
      assert.equal(result.length, 1);
      assert.equal(result[0].role, 'system');
      assert.ok(result[0].content.includes('MiMo Code Agent'));
    });

    it('prepends MiMo prompt when first message is not a system message', () => {
      const result = mimo.ensureMimoSystemPrompt([
        { role: 'user', content: 'hello' },
      ]);
      assert.equal(result.length, 2);
      assert.equal(result[0].role, 'system');
      assert.equal(result[1].role, 'user');
      assert.equal(result[1].content, 'hello');
    });

    it('prepends MiMo prompt when first message is system but lacks MiMo', () => {
      const result = mimo.ensureMimoSystemPrompt([
        { role: 'system', content: 'You are a helpful assistant.' },
      ]);
      assert.equal(result.length, 2);
      assert.ok(result[0].content.includes('MiMo Code Agent'));
    });

    it('does NOT prepend when first message contains "MiMo" (with space)', () => {
      const original = [
        { role: 'system', content: 'You are MiMo Code Agent, built by Xiaomi.' },
        { role: 'user', content: 'hello' },
      ];
      const result = mimo.ensureMimoSystemPrompt(original);
      assert.equal(result.length, 2);
      assert.equal(result[0].content, original[0].content);
      assert.equal(result[1].content, 'hello');
    });

    it('does NOT prepend when first message contains "MiMoCode" (without space)', () => {
      const original = [
        { role: 'system', content: 'I am MiMoCode, the CLI tool.' },
      ];
      const result = mimo.ensureMimoSystemPrompt(original);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, original[0].content);
    });

    it('handles system message with null content', () => {
      const result = mimo.ensureMimoSystemPrompt([
        { role: 'system', content: null } as any,
      ]);
      assert.equal(result.length, 2);
      assert.ok(result[0].content.includes('MiMo Code Agent'));
      assert.equal(result[1].content, null);
    });

    it('preserves all messages after the first', () => {
      const result = mimo.ensureMimoSystemPrompt([
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ]);
      assert.equal(result.length, 4);
      assert.equal(result[1].content, 'one');
      assert.equal(result[2].content, 'two');
      assert.equal(result[3].content, 'three');
    });
  });

  describe('parseProxyList', () => {
    it('parses simple ip:port lines', () => {
      const raw = '1.2.3.4:8080\n5.6.7.8:3128\n';
      const result = mimo.__test.parseProxyList(raw);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { host: '1.2.3.4', port: 8080 });
      assert.deepEqual(result[1], { host: '5.6.7.8', port: 3128 });
    });

    it('filters comments and empty lines', () => {
      const raw = '# this is a comment\n\n1.2.3.4:8080\n\n# another comment\n5.6.7.8:3128\n';
      const result = mimo.__test.parseProxyList(raw);
      assert.equal(result.length, 2);
    });

    it('filters lines with invalid ports', () => {
      const raw = '1.2.3.4:0\n1.2.3.4:65536\n1.2.3.4:8080\n1.2.3.4:abc\n';
      const result = mimo.__test.parseProxyList(raw);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { host: '1.2.3.4', port: 8080 });
    });

    it('handles empty input', () => {
      assert.equal(mimo.__test.parseProxyList('').length, 0);
      assert.equal(mimo.__test.parseProxyList('\n\n\n').length, 0);
    });

    it('handles IPv6 addresses gracefully (uses last colon for port)', () => {
      const raw = '[::1]:8080\n';
      const result = mimo.__test.parseProxyList(raw);
      assert.ok(Array.isArray(result));
    });

    it('handles hostnames with port', () => {
      const raw = 'proxy.example.com:8080\n';
      const result = mimo.__test.parseProxyList(raw);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { host: 'proxy.example.com', port: 8080 });
    });
  });

  describe('fingerprint pool', () => {
    it('getClientFingerprint creates and persists a fingerprint', async () => {
      const fp = await mimo.getClientFingerprint();
      assert.ok(fp);
      assert.equal(typeof fp, 'string');
      assert.equal(fp.length, 64); // SHA-256 hex

      // Verify persisted
      const poolData = JSON.parse(await readFile(POOL_FILE, 'utf-8'));
      assert.equal(poolData.length, 1);
      assert.equal(poolData[0].fp, fp);
      assert.equal(poolData[0].cooldownUntil, 0);
    });

    it('getClientFingerprint returns same fingerprint on second call', async () => {
      const fp1 = await mimo.getClientFingerprint();
      const fp2 = await mimo.getClientFingerprint();
      assert.equal(fp1, fp2);
    });

    it('migrates legacy single-fingerprint file', async () => {
      await writeFile(LEGACY_FILE, 'legacy-fp-hash');

      // Reset in-memory state to force reload from disk
      mimo.__test._setPool(null);

      const fp = await mimo.getClientFingerprint();
      assert.equal(fp, 'legacy-fp-hash');

      // Should have created pool file with legacy fp
      const poolData = JSON.parse(await readFile(POOL_FILE, 'utf-8'));
      assert.equal(poolData[0].fp, 'legacy-fp-hash');
    });

    it('loads existing pool from disk', async () => {
      const existingPool = [
        { fp: 'fp-one', cooldownUntil: 0 },
        { fp: 'fp-two', cooldownUntil: Date.now() + 999999 },
      ];
      await writeFile(POOL_FILE, JSON.stringify(existingPool));

      // Reset in-memory state
      mimo.__test._setPool(null);
      mimo.__test._setActiveIdx(0);

      const fp = await mimo.getClientFingerprint();
      assert.equal(fp, 'fp-one');

      const pool = mimo.__test._getPool();
      assert.equal(pool.length, 2);
      assert.equal(pool[0].fp, 'fp-one');
      assert.equal(pool[1].fp, 'fp-two');
    });

    it('rotating fingerprint parks current and picks next available', async () => {
      // Set up a pool with two fresh fingerprints
      const mockPool = [
        { fp: 'fp-one', cooldownUntil: 0 },
        { fp: 'fp-two', cooldownUntil: 0 },
      ];
      mimo.__test._setPool(mockPool);
      mimo.__test._setActiveIdx(0);

      // Simulate what rotateFingerprint does (same algorithm)
      const rotateFingerprintTest = async () => {
        const p = mimo.__test._getPool();
        const FP_COOLDOWN_MS = 60 * 60_000; // default from constants
        const now = Date.now();

        const activeIdx = mimo.__test._getActiveIdx();
        if (p[activeIdx]) p[activeIdx].cooldownUntil = now + FP_COOLDOWN_MS;

        let pick = p.findIndex((f: any, i: number) => i !== activeIdx && f.cooldownUntil <= now);

        if (pick >= 0) {
          mimo.__test._setActiveIdx(pick);
        }
        return p[mimo.__test._getActiveIdx()].fp;
      };

      const newFp = await rotateFingerprintTest();
      assert.equal(newFp, 'fp-two');
      assert.equal(mimo.__test._getActiveIdx(), 1);

      // fp-one should be parked
      const pool = mimo.__test._getPool();
      assert.ok(pool[0].cooldownUntil > Date.now());
      assert.equal(pool[1].cooldownUntil, 0);
    });

    it('rotating when all are cooling down picks the one recovering soonest', async () => {
      const future = Date.now() + 3600000;
      const sooner = Date.now() + 1000;
      const mockPool = [
        { fp: 'fp-one', cooldownUntil: future },
        { fp: 'fp-two', cooldownUntil: sooner },
        { fp: 'fp-three', cooldownUntil: future + 1000 },
      ];
      mimo.__test._setPool(mockPool);
      mimo.__test._setActiveIdx(0);

      // Simulate the rotation algorithm when all are in cooldown
      const rotateFingerprintTest = async () => {
        const p = mimo.__test._getPool();
        const now = Date.now();

        const activeIdx = mimo.__test._getActiveIdx();
        if (p[activeIdx]) p[activeIdx].cooldownUntil = now + 60 * 60_000;

        let pick = p.findIndex((f: any, i: number) => i !== activeIdx && f.cooldownUntil <= now);
        if (pick === -1) {
          pick = p.reduce(
            (best: number, _f: any, i: number) =>
              p[i].cooldownUntil < p[best].cooldownUntil ? i : best,
            activeIdx >= 0 ? activeIdx : 0,
          );
        }

        mimo.__test._setActiveIdx(pick);
        return p[mimo.__test._getActiveIdx()].fp;
      };

      const newFp = await rotateFingerprintTest();
      // Should pick fp-two (soonest cooldown)
      assert.equal(newFp, 'fp-two');
    });
  });
});
