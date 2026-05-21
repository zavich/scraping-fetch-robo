import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.join(rootDir, 'task-definition.json');
const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'dist', 'task-definition.rendered.json');

const template = await readFile(inputPath, 'utf8');
const rendered = template.replace(/<([A-Z0-9_]+)>/g, (_, key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Variavel obrigatoria ausente para task definition: ${key}`);
  }

  return value;
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, rendered);
console.log(`Task definition renderizada em ${outputPath}`);
