import { readFileSync } from 'fs';
const content = readFileSync('src/dashboard.ts', 'utf8');
const match = content.match(/<script>([\s\S]*?)<\/script>/);
const script = match?.[1];
console.log('Script length:', script?.length);
try {
  new Function(script);
  console.log('OK');
} catch(e) {
  console.log('Error:', e.message);
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    try {
      new Function(lines[i]);
    } catch(e2) {
      console.log('Bad line', i+1, ':', lines[i].trim().slice(0, 120));
    }
  }
}
