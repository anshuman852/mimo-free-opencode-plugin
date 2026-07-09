import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const PLUGIN_NAME = 'mimo-free-opencode-plugin';
const SCHEMA_URL = 'https://opencode.ai/config.json';

function getGlobalConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const dir = join(configHome, 'opencode');
  if (existsSync(join(dir, 'opencode.json'))) {
    return join(dir, 'opencode.json');
  }
  return join(dir, 'opencode.jsonc');
}

async function findProjectConfigDir(): Promise<string> {
  let dir = process.cwd();
  while (true) {
    try {
      await stat(join(dir, '.git'));
      return dir; // found git root
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return process.cwd();
}

async function getProjectConfigPath(): Promise<string> {
  const dir = await findProjectConfigDir();
  // Prefer .jsonc
  return join(dir, 'opencode.jsonc');
}

function stripJsonComments(json: string): string {
  let result = '';
  let i = 0;

  while (i < json.length) {
    const ch = json[i];

    // String literal — copy verbatim until closing quote
    if (ch === '"') {
      result += ch;
      i++;
      while (i < json.length) {
        const c = json[i];
        result += c;
        i++;
        if (c === '\\') {
          // escape sequence, consume next char
          if (i < json.length) {
            result += json[i];
            i++;
          }
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }

    // Single-line comment //
    if (ch === '/' && i + 1 < json.length && json[i + 1] === '/') {
      i += 2;
      while (i < json.length && json[i] !== '\n') i++;
      continue;
    }

    // Block comment /* */
    if (ch === '/' && i + 1 < json.length && json[i + 1] === '*') {
      i += 2;
      while (i + 1 < json.length && !(json[i] === '*' && json[i + 1] === '/')) i++;
      i += 2; // skip */
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas after stripping comments
  return result.replace(/,\s*([}\]])/g, '$1');
}

function formatConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2) + '\n';
}

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, 'utf-8');
  const stripped = stripJsonComments(raw);
  return JSON.parse(stripped);
}

async function configExists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

async function setup(targetPath: string, label: string): Promise<void> {
  const exists = await configExists(targetPath);
  let config: Record<string, unknown> = {};

  if (exists) {
    try {
      config = await readConfig(targetPath);
    } catch (err) {
      console.error(`✗ Failed to parse ${targetPath}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    config.$schema = SCHEMA_URL;
    await mkdir(dirname(targetPath), { recursive: true });
  }

  let plugins = config.plugin as string[] | undefined;
  if (!plugins || !Array.isArray(plugins)) {
    plugins = [];
    config.plugin = plugins;
  }

  if (plugins.includes(PLUGIN_NAME)) {
    console.log(`✓ Plugin already configured in ${label}`);
    console.log(`  ${targetPath}`);
    return;
  }

  plugins.push(PLUGIN_NAME);
  config.plugin = plugins;

  await writeFile(targetPath, formatConfig(config));

  if (exists) {
    console.log(`✓ Added ${PLUGIN_NAME} to ${label}`);
  } else {
    console.log(`✓ Created ${label} with ${PLUGIN_NAME}`);
  }
  console.log(`  ${targetPath}`);
  console.log(``);
  console.log(`  Run \`opencode\` and pick "MiMo Auto (Free)" from the model list.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] !== 'setup') {
    console.log('mimo-free-opencode-plugin — MiMo Auto (Free) for OpenCode');
    console.log('');
    console.log('Usage:');
    console.log('  npx mimo-free-opencode-plugin setup            Configure globally');
    console.log('  npx mimo-free-opencode-plugin setup --project  Configure for this project');
    process.exit(0);
  }

  const projectFlag = args.includes('--project');

  if (projectFlag) {
    const projectPath = await getProjectConfigPath();
    await setup(projectPath, 'project config');
  } else {
    const globalPath = getGlobalConfigPath();
    await setup(globalPath, 'global config');
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
