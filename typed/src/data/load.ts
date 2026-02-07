import fs from 'fs';
import path from 'path';

export function loadJson<T>(fileName: string): T {
  const filePath = path.join(__dirname, '..', '..', '..', 'data', `${fileName}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}
